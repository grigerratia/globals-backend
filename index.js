import cron from "node-cron";
import { initializeApp, cert } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';
import express from 'express';
import cors from 'cors';
import qrcodeData from 'qrcode';
import { default as makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chromeLibs = path.join(__dirname, '.chrome-libs/usr/lib/x86_64-linux-gnu');
process.env.LD_LIBRARY_PATH = [chromeLibs, process.env.LD_LIBRARY_PATH]
  .filter(Boolean)
  .join(':');
process.env.PUPPETEER_CACHE_DIR ??= path.join(os.homedir(), '.cache/puppeteer');

function resolveChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const chromeRoot = path.join(os.homedir(), '.cache/puppeteer/chrome');
  if (!fs.existsSync(chromeRoot)) return undefined;

  const versions = fs.readdirSync(chromeRoot).sort().reverse();
  for (const version of versions) {
    const candidate = path.join(chromeRoot, version, 'chrome-linux64', 'chrome');
    if (fs.existsSync(candidate)) return candidate;
  }

  return undefined;
}

// Inicializar Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

let serviceAccount = {};
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // Decodificar desde base64 para evitar problemas con caracteres especiales
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8');
    serviceAccount = JSON.parse(decoded);
  } else if (fs.existsSync('./firebase-service-account.json')) {
    serviceAccount = JSON.parse(fs.readFileSync('./firebase-service-account.json', 'utf8'));
  }
} catch (e) {
  console.error("Error parseando firebase-service-account", e);
}

initializeApp({
  credential: cert(serviceAccount)
});
const messaging = getMessaging();

async function enviarPushNotificacion(titulo, body, userIds) {
  if (!userIds || userIds.length === 0) return;
  const { data, error } = await supabase
    .from("fcm_tokens")
    .select("token")
    .in("user_id", userIds);

  if (error || !data || data.length === 0) return;
  
  // Guardar notificacion en la base de datos para la campanita interna
  const notifsToInsert = userIds.map(uid => ({
    user_id: uid,
    titulo: titulo,
    mensaje: body
  }));
  const { error: notifErr } = await supabase.from("notificaciones").insert(notifsToInsert);
  if(notifErr) console.error("Error insertando notificacion:", notifErr.message);

  const tokens = [...new Set(data.map(d => d.token))];
  const message = {
    notification: {
      title: titulo,
      body: body,
    },
    tokens: tokens,
  };

  try {
    const response = await messaging.sendEachForMulticast(message);
    console.log("[FCM] Notificaciones enviadas: " + response.successCount + " éxitos, " + response.failureCount + " fallos");
    if (response.failureCount > 0) {
      const failedTokens = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const errorCode = resp.error?.code;
          if (errorCode === "messaging/invalid-registration-token" || errorCode === "messaging/registration-token-not-registered") {
            failedTokens.push(tokens[idx]);
          }
        }
      });
      if (failedTokens.length > 0) {
        console.log("[FCM] Eliminando " + failedTokens.length + " tokens inválidos...");
        await supabase.from("fcm_tokens").delete().in("token", failedTokens);
      }
    }
  } catch (error) {
    console.error("[FCM] Error enviando notificaciones push:", error);
  }
}


const SYSTEM_PROMPT = `Eres el asistente virtual de Global's, una agencia de publicidad y marketing en Venezuela. Tu tono debe ser cálido y amable, pero siempre manteniendo la profesionalidad y formalidad. Saluda y despídete con cordialidad, usando un lenguaje respetuoso. Evita usar demasiados emojis o exceso de coloquialismos. Tu objetivo es recabar información del cliente para generar requerimientos claros y devolver un JSON estructurado.
Para registrar el pedido, NECESITAS recolectar OBLIGATORIAMENTE esta información:
1. Qué servicio/producto necesita y sus detalles básicos (medidas, material).
2. El Cliente (Nombre de la empresa o negocio, Ej: Hato Grill, Ferretería El Sol).
3. La Persona de Contacto (Nombre de la persona con la que hablas, Ej: Juan Pérez).
4. El Número de teléfono de la persona de contacto (pídelo explícitamente para guardarlo en la ficha).

REGLAS ESTRICTAS DE RESPUESTA:
Debes responder SIEMPRE y ÚNICAMENTE con un objeto JSON válido (sin formato markdown ni texto extra).

Caso 1: Si falta información (detalles, empresa, persona de contacto, o teléfono), mantén la conversación viva para solicitar lo que falta:
{
  "tipo": "conversacion",
  "respuesta": "¡Hola! Con gusto le ayudamos con su requerimiento. ¿Me podría indicar a nombre de qué empresa o negocio lo registramos y el nombre de la persona de contacto?"
}

Caso 2: Si el usuario solo está agradeciendo, diciendo 'ok', 'vale', o despidiéndose (después de que ya registraste su pedido o durante la charla), o si YA creaste el proyecto en mensajes anteriores, NO pidas más datos ni envíes proyecto_listo de nuevo, solo despídete amablemente:
{
  "tipo": "conversacion",
  "respuesta": "Entendido. La información ha sido registrada. Un miembro de nuestro equipo comercial se comunicará a la brevedad posible."
}

Caso 3: Si ya tienes los detalles del pedido, la persona de contacto, el TELÉFONO y el cliente/empresa (o si dijo que no tiene empresa) y es el momento de crear el proyecto en el sistema:
{
  "tipo": "proyecto_listo",
  "titulo": "Resumen corto (Ej: Letrero Luminoso 2x1)",
  "nombre_cliente": "Juan Pérez",
  "empresa": "Hato Grill",
  "cliente_telefono": "0987654321",
  "notas": "Descripción completa de lo que pidió el cliente",
  "estado": "En Conversación"
}`;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Asegurar que la columna 'En Conversación' exista en Supabase al arrancar
async function asegurarColumna() {
  const { data, error } = await supabase.from('columnas').select('nombre').eq('nombre', 'En Conversación');
  if (!error && data.length === 0) {
    await supabase.from('columnas').insert([{ nombre: 'En Conversación', orden: -1 }]);
    console.log('✅ Columna "En Conversación" creada oficialmente en la base de datos.');
  }
}
asegurarColumna();

function parseClassification(raw) {
  try {
    const cleaned = String(raw).replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('Error parseando JSON de Gemini:', e);
    return { tipo: 'conversacion', respuesta: 'Lo siento, no entendí bien. ¿Podrías repetirlo?' };
  }
}

const PORT = 3000;
const app = express();
app.use(cors());
app.use(express.json());

let waState = 'DISCONNECTED';
let latestQrDataUrl = null;

// Endpoint para chequear la memoria (Qué tan apretado está el backend)
app.get('/api/metrics', (req, res) => {
  const used = process.memoryUsage();
  const memoryInfo = {
    rss: `${Math.round(used.rss / 1024 / 1024 * 100) / 100} MB (Memoria total del proceso)`,
    heapTotal: `${Math.round(used.heapTotal / 1024 / 1024 * 100) / 100} MB (Tamaño del heap)`,
    heapUsed: `${Math.round(used.heapUsed / 1024 / 1024 * 100) / 100} MB (Heap en uso)`,
    sistema_libre: `${Math.round(os.freemem() / 1024 / 1024)} MB`,
    sistema_total: `${Math.round(os.totalmem() / 1024 / 1024)} MB`
  };
  res.json(memoryInfo);
});

// Endpoint principal para el estado de WhatsApp
app.get('/api/whatsapp/status', (_req, res) => {
  res.json({
    status: waState,
    qr: latestQrDataUrl
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});


const recentUpdates = new Set();
const activeChats = new Map();






supabase
  .channel('backend-estado-updates')
  .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'proyectos' }, async (payload) => {
    const oldRecord = payload.old;
    const newRecord = payload.new;

    
    // Detectar si se agregó un encargado nuevo
    const oldEnc = oldRecord.encargados || [];
    const newEnc = newRecord.encargados || [];
    
    // Buscar encargados que están en newEnc pero no en oldEnc (comparando id o user_id)
    const agregados = newEnc.filter(n => !oldEnc.some(o => (o.user_id && o.user_id === n.user_id) || (o.id && o.id === n.id) || (o.nombre === n.nombre)));
    
    if (agregados.length > 0) {
      console.log(`[👥 NUEVO ENCARGADO] En proyecto "${newRecord.titulo}"`);
      for (const enc of agregados) {
        if (enc.user_id || enc.id) {
          await enviarPushNotificacion("Nuevo Proyecto Asignado", `Fuiste asignado al proyecto: ${newRecord.titulo}`, [enc.user_id || enc.id]);
        }
        let num = null;
        if (enc.telefono) num = enc.telefono.replace(/[^0-9]/g, '');
        else {
           const nom = enc.nombre ? enc.nombre.toLowerCase() : '';
           if (nom.includes("griger")) num = "584248037379";
           else if (nom.includes("idalys")) num = "584122966969";
        }
        if (num && num.length >= 10) {
           try {
             if (clientSocket && waState === 'CONNECTED') {
                await clientSocket.sendMessage(`${num}@s.whatsapp.net`, { text: `📌 *Nuevo Proyecto Asignado*\nHas sido asignado al proyecto: *${newRecord.titulo}*.` });
                console.log(`[WHATSAPP] Aviso de asignación a ${enc.nombre} (${num})`);
                await sleep(5000);
             }
           } catch(e) {
             console.error(`Error avisando asignación a ${enc.nombre}:`, e.message);
           }
        }
      }
    }

    if (oldRecord.estado !== newRecord.estado && newRecord.estado !== 'Archivado') {
      
      const dedupeKey = `${newRecord.id}-${newRecord.estado}`;
      if (recentUpdates.has(dedupeKey)) {
        return;
      }
      recentUpdates.add(dedupeKey);
      setTimeout(() => recentUpdates.delete(dedupeKey), 5000);

      console.log(`[🔄 CAMBIO DE ESTADO] Proyecto "${newRecord.titulo}" -> "${newRecord.estado}"`);
      
      // Notificar cliente
      if (newRecord.cliente_telefono) {
        const numeroLimpiado = newRecord.cliente_telefono.replace(/[^0-9]/g, '');
        if (numeroLimpiado.length >= 10) {
          const mensaje = `¡Hola! Te escribimos de Global's para informarte que tu proyecto *"${newRecord.titulo}"* ha sido movido a la columna: *${newRecord.estado}*.\n\nTe seguiremos informando.`;
          
          try {
            const chatId = `${numeroLimpiado}@s.whatsapp.net`;
            if (clientSocket && waState === 'CONNECTED') {
               // clientSocket.sendMessage(chatId, { text: mensaje })
                 // .then(() => console.log(`✅ Notificación enviada a ${numeroLimpiado}`))
                 // .catch(err => console.error(`❌ Error al enviar aviso a ${numeroLimpiado}:`, err.message));
            } else {
               console.log(`[SIMULACIÓN] Mensaje que se habría enviado a ${numeroLimpiado}: ${mensaje}`);
            }
          } catch (err) {
            console.error(`❌ Error general al enviar aviso a ${numeroLimpiado}:`, err.message);
          }
        }
      }

      // Enviar notificaciones PUSH y WA a los encargados
      if (newRecord.encargados && newRecord.encargados.length > 0) {
        const userIds = newRecord.encargados.filter(e => (e.user_id || e.id)).map(e => (e.user_id || e.id));
        const pushMsg = "El proyecto " + newRecord.titulo + " fue movido a la columna: " + newRecord.estado;
        
        if (userIds.length > 0) {
          // Add a 5 second delay so the user has time to background the app
          setTimeout(async () => {
            await enviarPushNotificacion("Actualización de Proyecto", pushMsg, userIds);
          }, 5000);
        }
        
        for (const encargado of newRecord.encargados) {
          if (!encargado.nombre) {
            continue;
          }
          
          let num = null;
          if (encargado.telefono) {
            num = encargado.telefono.replace(/[^0-9]/g, '');
          } else {
            const nom = encargado.nombre.toLowerCase();
            if (nom.includes("griger")) num = "584248037379";
            else if (nom.includes("idalys")) num = "584122966969";
          }
          
          if (num && num.length >= 10) {
            try {
              if (clientSocket && waState === 'CONNECTED') {
                await clientSocket.sendMessage(`${num}@s.whatsapp.net`, { text: `⚠️ *Actualización de Proyecto*\n${pushMsg}` });
                console.log(`[WHATSAPP] Notificación enviada a encargado ${encargado.nombre} (${num})`);
                await sleep(5000); 
              }
            } catch (err) {
              console.error(`❌ Error al enviar aviso WA a encargado ${encargado.nombre}:`, err.message);
            }
          }
        }
      }
    }
  })
  .subscribe((status, err) => {
    if (status === 'SUBSCRIBED') {
      console.log('Backend suscrito a cambios de estado en Supabase');
    } else {
      console.error('Realtime estado status:', status, err);
      if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
         setTimeout(() => process.exit(1), 5000); // Fuerza a Render a reiniciar la app para recuperar el WebSocket
      }
    }
  });

supabase
  .channel('comentarios-updates')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'comentarios' }, async (payload) => {
    const newComment = payload.new;
    console.log(`[💬 NUEVO COMENTARIO] Proyecto ID: ${newComment.proyecto_id}, Por: ${newComment.autor_nombre}`);
    
    // Buscar encargados del proyecto
    const { data: proyecto, error } = await supabase
      .from('proyectos')
      .select('titulo, encargados')
      .eq('id', newComment.proyecto_id)
      .single();
      
    if (!error && proyecto && proyecto.encargados && proyecto.encargados.length > 0) {
      // Filtrar a los encargados que no sean el autor del comentario (si es que tenemos su id)
      // Asumiendo que el autor_id no está disponible directamente o si, mandamos a todos por ahora
      const userIds = proyecto.encargados.filter(e => e.user_id && e.nombre !== newComment.autor_nombre).map(e => e.user_id);
      
      if (userIds.length > 0) {
        const pushMsg = `${newComment.autor_nombre} comentó en ${proyecto.titulo}: "${newComment.texto.substring(0, 50)}..."`;
        await enviarPushNotificacion("Nuevo Comentario", pushMsg, userIds);
      }
    }
  })
  .subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      console.log('Backend suscrito a nuevos comentarios');
    }
  });




let clientSocket = null;

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
  
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' })
  });
  
  clientSocket = sock;

  sock.ev.on('creds.update', saveCreds);

  
  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const remoteJid = msg.key.remoteJid;
      if (remoteJid.includes("@g.us")) return;
      const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;

      if (textMessage && textMessage.trim() !== '') {
        console.log(`[BOT] Mensaje recibido de ${remoteJid}: ${textMessage}`);
        
        

        const phoneNumber = remoteJid.split('@')[0];
        
        // Buscar si el cliente ya tiene proyectos
        const { data: clientProjects } = await supabase
          .from('proyectos')
          .select('titulo, estado, notas, fecha_entrega')
          .ilike('cliente_telefono', `%${phoneNumber}%`)
          .order('fecha_ultima_actualizacion', { ascending: false })
          .limit(3);

        let dynamicPrompt = SYSTEM_PROMPT;
        if (clientProjects && clientProjects.length > 0) {
          const projectList = clientProjects.map(p => 
            `- Título: ${p.titulo}, Estado: ${p.estado}, Notas: ${p.notas}, Entrega: ${p.fecha_entrega || 'N/A'}`
          ).join('\n');
          
          dynamicPrompt += `\n\n¡IMPORTANTE! Este cliente YA TIENE los siguientes proyectos registrados en el sistema:\n${projectList}\n\nSi el cliente está preguntando por el estatus de su pedido, infórmale cordialmente basándote en esta información y NO generes un nuevo proyecto (usa tipo: conversacion). Si el cliente está pidiendo algo COMPLETAMENTE NUEVO, entonces sí pide los datos faltantes para crear un nuevo proyecto.`;
        }

        const modelosATestar = [
          'gemini-3.8-flash',
          'gemini-3.5-flash-lite',
          'gemini-3.1-flash-lite',
          'gemini-flash-latest',
          'gemini-flash-lite-latest'
        ];
        
        let classification = null;
        let success = false;
        
        for (const modelName of modelosATestar) {
          try {
            console.log(`[BOT] Intentando responder con el modelo: ${modelName}`);
            const model = genAI.getGenerativeModel({
              model: modelName,
              systemInstruction: dynamicPrompt,
              generationConfig: {
                responseMimeType: 'application/json',
              },
            });

            
            
            let userHistory = activeChats.get(remoteJid) || [];
            
            const chatSession = model.startChat({ history: userHistory });
            const result = await chatSession.sendMessage(textMessage);
            
            userHistory = await chatSession.getHistory();
            activeChats.set(remoteJid, userHistory);
            
            classification = parseClassification(result.response.text());

            success = true;
            break; // Salimos del for loop si tuvo éxito
          } catch (modelErr) {
            console.error(`[BOT] Falló el modelo ${modelName}: ${modelErr.message}`);
          }
        }
        
        if (!success || !classification) {
           throw new Error("Todos los modelos de Gemini fallaron o están saturados.");
        }


        if (classification.tipo === 'conversacion') {
          await sock.sendMessage(remoteJid, { text: classification.respuesta });
        } else if (classification.tipo === 'proyecto_listo') {
          activeChats.delete(remoteJid);
          await sock.sendMessage(remoteJid, { text: "Gracias por la información. Hemos registrado los detalles de su proyecto y nuestro equipo comercial los revisará en breve." });
          
          
          // Buscar Líder Comercial por defecto
          const { data: liderData } = await supabase.from('usuarios').select('id, nombre, rol').eq('rol', 'Líder Comercial').limit(1);
          let encargados_default = [];
          if (liderData && liderData.length > 0) {
            encargados_default = [{ id: liderData[0].id, nombre: liderData[0].nombre, rol: 'Líder Comercial' }];
          }

          const { error: insertErr } = await supabase.from('proyectos').insert([{
            titulo: classification.titulo,
            cliente_nombre: classification.nombre_cliente,
            cliente_empresa: classification.empresa,
            cliente_telefono: classification.cliente_telefono,
            notas: classification.notas,
            estado: classification.estado || 'En Conversación',
            fecha_entrega: null,
            encargados: encargados_default
          }]);
          
          if (insertErr) {
            console.error('[BOT] Error al guardar proyecto en DB:', insertErr);
          } else {
            console.log('[BOT] Proyecto creado en base de datos desde WhatsApp');
          }

        }
      }
    } catch (err) {
      console.error('[BOT] Error procesando mensaje entrante:', err);
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      console.log('[WHATSAPP] QR Event recibido.');
      waState = 'QR_READY';
      try {
        latestQrDataUrl = await qrcodeData.toDataURL(qr);
      } catch(e) {
        console.error('Error al generar QR data URL:', e);
      }
    }


    if (connection === 'close') {
      const statusCode = (lastDisconnect.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      console.log('[WHATSAPP] Conexión cerrada. ¿Reconectar?', shouldReconnect, 'Status Code:', statusCode);
      
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 2000);
      } else {
        console.log('[WHATSAPP] Sesión cerrada (loggedOut). Borrando credenciales y reiniciando...');
        waState = 'DISCONNECTED';
        try {
          fs.rmSync('./baileys_auth_info', { recursive: true, force: true });
        } catch(err) {
          console.error('Error al borrar .wwebjs_auth:', err);
        }
        setTimeout(connectToWhatsApp, 3000);
      }
    }
 else if (connection === 'open') {
      console.log('[WHATSAPP] Client is ready!');
      waState = 'CONNECTED';
      latestQrDataUrl = null;
    }
  });
}

connectToWhatsApp();

app.listen(PORT, () => {
  console.log(`Servidor Express escuchando en http://localhost:${PORT}`);

  // Keep-alive: hacer ping cada 14 minutos para que Render no duerma el servidor
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL || process.env.RENDER_SERVICE_URL;
  if (RENDER_URL) {
    setInterval(async () => {
      try {
        const res = await fetch(`${RENDER_URL}/health`);
        console.log(`[KEEP-ALIVE] Ping exitoso: ${res.status}`);
      } catch (e) {
        console.error('[KEEP-ALIVE] Error en ping:', e.message);
      }
    }, 14 * 60 * 1000); // Cada 14 minutos
    console.log('[KEEP-ALIVE] Auto-ping activado cada 14 minutos');
  }
});
// CRON JOB para notificaciones






function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Se ejecuta todos los días a las 8:00 AM



cron.schedule("0 8 * * *", async () => {
  console.log("[CRON] Verificando proyectos atrasados...");
  
  const { data: proyectos, error } = await supabase
    .from("proyectos")
    .select("*")
    .not("estado", "in", "(" + `"Entregado y cerrado"` + ", " + `"Archivado"` + ")");

  if (error || !proyectos) {
    console.error("Error al consultar proyectos para CRON:", error);
    return;
  }

  const hoyNorm = new Date();
  hoyNorm.setHours(0,0,0,0);
  const alertas = [];

  for (const pry of proyectos) {
    let necesitaAlerta = false;
    let msj = "";

    if (pry.fecha_entrega) {
      const fechaEntrega = new Date(pry.fecha_entrega);
      fechaEntrega.setHours(0,0,0,0);
      
      const diffDays = Math.round((fechaEntrega - hoyNorm) / (1000 * 60 * 60 * 24));
      
      if (diffDays === 1) {
        msj = `⚠️ *RECORDATORIO DE ENTREGA*\nPrepara todo para mañana. El proyecto "${pry.titulo}" está agendado para entregarse el ${fechaEntrega.toLocaleDateString()}.\nFase actual: ${pry.estado}`;
        necesitaAlerta = true;
      } else if (diffDays === 0) {
        msj = `🚨 *ENTREGA FINAL HOY*\n¡El día llegó! El proyecto "${pry.titulo}" debe entregarse hoy sin falta.\nFase actual: ${pry.estado}`;
        necesitaAlerta = true;
      } else if (diffDays < 0) {
        msj = `💥 *PROYECTO RETRASADO*\nEl proyecto "${pry.titulo}" tiene la fecha de entrega vencida (${fechaEntrega.toLocaleDateString()}). Por favor, actualiza su estado o comunícate con el cliente.\nFase actual: ${pry.estado}`;
        necesitaAlerta = true;
      }
    }
    
    
    if (pry.levantamiento_fecha) {
      const fechaLevantamiento = new Date(pry.levantamiento_fecha);
      fechaLevantamiento.setHours(0,0,0,0);
      const diffLevantamiento = Math.round((fechaLevantamiento - hoyNorm) / (1000 * 60 * 60 * 24));
      
      if (diffLevantamiento === 1) {
        msj += (msj ? '\n\n' : '') + `⚠️ *RECORDATORIO LEVANTAMIENTO*\nMañana (${fechaLevantamiento.toLocaleDateString()}) es el levantamiento del proyecto "${pry.titulo}".`;
        necesitaAlerta = true;
      } else if (diffLevantamiento === 0) {
        msj += (msj ? '\n\n' : '') + `🚨 *LEVANTAMIENTO HOY*\nHoy es el levantamiento programado para el proyecto "${pry.titulo}".`;
        necesitaAlerta = true;
      }
    }
    
    if (!necesitaAlerta && pry.fecha_ultima_actualizacion) {
      const fechaUltima = new Date(pry.fecha_ultima_actualizacion);
      fechaUltima.setHours(0,0,0,0);
      const diasEstancado = Math.floor((hoyNorm - fechaUltima) / (1000 * 60 * 60 * 24));
      
      if (diasEstancado >= 2) {
        necesitaAlerta = true;
        try {
          const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
          const prompt = `Actúas como un asistente de gestión de proyectos muy natural y humano. 
          Tienes que redactar un mensaje corto (máximo 30-40 palabras) de notificación push para avisarle al equipo que un proyecto está estancado.
          
          Datos del proyecto:
          - Título: "${pry.titulo}"
          - Días estancado: ${diasEstancado}
          - Fase actual: "${pry.estado}"
          
          INSTRUCCIONES:
          - No seas robótico. Usa un tono alerta pero colaborativo y directo.
          - Inicia con un emoji (ej. ⏳ o 🚨).
          - Menciona claramente lo que deben hacer para avanzar, dependiendo de la fase actual. Por ejemplo, si está en 'Levantamiento', diles que deben cotizar y enviar presupuesto. Si está en 'En Diseño', diles que revisen y aprueben el arte.
          - NO uses formato markdown complejo, solo texto plano y amigable.`;
          
          const aiResponse = await model.generateContent(prompt);
          msj = "Alerta\nProyecto estancado\n" + aiResponse.response.text().trim();
        } catch (e) {
          console.error('Error usando Gemini para CRON:', e);
          msj = `⏳ *PROYECTO ESTANCADO*\nEl proyecto "${pry.titulo}" lleva ${diasEstancado} días sin avanzar.\nFase actual: ${pry.estado}`;
        }
      }
    }

    if (necesitaAlerta) {
      let tituloPush = "⚠️ Alerta de Proyecto";
      if (msj.includes("MAÑANA") || msj.includes("mañana") || msj.includes("RECORDATORIO")) tituloPush = "⏰ Recordatorio de Proyecto";
      else if (msj.includes("HOY") || msj.includes("hoy") || msj.includes("FINAL")) tituloPush = "🚨 Proyecto Vence HOY";
      else if (msj.includes("RETRASADO")) tituloPush = "💥 Proyecto Retrasado";
      else if (msj.includes("ESTANCADO") || msj.includes("estancado")) tituloPush = "⏳ Proyecto Estancado";

      alertas.push({
        proyecto: pry.titulo,
        mensaje: msj,
        tituloPush: tituloPush,
        encargados: pry.encargados || []
      });
    }
  }

  if (alertas.length === 0) {
    console.log("[CRON] Ningún proyecto requiere alerta el día de hoy.");
    return;
  }

  console.log(`[CRON] Se procesarán ${alertas.length} alertas...`);
  
  for (const alerta of alertas) {
    const pushUserIds = alerta.encargados.filter(e => (e.user_id || e.id)).map(e => (e.user_id || e.id));
    if (pushUserIds.length > 0) {
      await enviarPushNotificacion(alerta.tituloPush || "⚠️ Alerta de Proyecto", alerta.mensaje, pushUserIds);
    }

    for (const encargado of alerta.encargados) {
      if (!encargado.nombre) continue;
      
      let num = null;
      const nom = encargado.nombre.toLowerCase();
      if (nom.includes("griger")) num = "584248037379";
      else if (nom.includes("idalys")) num = "584122966969";

      if (num) {
        try {
          await clientSocket.sendMessage(`${num}@c.us`.replace('@c.us', '@s.whatsapp.net'), { text: alerta.mensaje });
          console.log(`[WHATSAPP-CRON] Mensaje enviado a ${encargado.nombre} (${num})`);
          await sleep(15000);
        } catch(e) {
          console.error(`Error WA Cron (${encargado.nombre}):`, e.message);
        }
      }
    }
  }
});


