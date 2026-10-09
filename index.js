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


// --- MANEJO GLOBAL DE ERRORES ---
process.on('uncaughtException', (err) => {
  console.error('[CRITICAL ERROR] Uncaught Exception:', err);
  // No salimos de proceso para no romper el backend
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL ERROR] Unhandled Rejection at:', promise, 'reason:', reason);
});
// --------------------------------

const PORT = 3000;
const app = express();
app.use(cors());
app.use(express.json());

let waState = 'DISCONNECTED';
let latestQrDataUrl = null;

// Endpoint para chequear la memoria (Qué tan apretado está el backend)

app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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
                await safeSendMessage(`${num}@s.whatsapp.net`, { text: `📌 *Nuevo Proyecto Asignado*\nHas sido asignado al proyecto: *${newRecord.titulo}*.` });
                console.log(`[WHATSAPP] Aviso de asignación a ${enc.nombre} (${num})`);
                
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
               // safeSendMessage(chatId, { text: mensaje })
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
                await safeSendMessage(`${num}@s.whatsapp.net`, { text: `⚠️ *Actualización de Proyecto*\n${pushMsg}` });
                console.log(`[WHATSAPP] Notificación enviada a encargado ${encargado.nombre} (${num})`);
                 
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


// --- WHATSAPP MESSAGE QUEUE ---
const waMessageQueue = [];
let isProcessingWaQueue = false;

async function processWaQueue() {
  if (isProcessingWaQueue) return;
  isProcessingWaQueue = true;

  while (waMessageQueue.length > 0) {
    const { jid, message, resolve, reject } = waMessageQueue.shift();
    try {
      if (clientSocket) {
        const result = await clientSocket.sendMessage(jid, message);
        resolve(result);
      } else {
        reject(new Error("WhatsApp socket no conectado"));
      }
    } catch (e) {
      console.error("[WA Queue] Error enviando mensaje a", jid, e.message);
      reject(e);
    }
    // Delay entre 5 y 10 segundos para evitar ban de Meta
    await new Promise(r => setTimeout(r, 5000 + Math.random() * 5000));
  }
  isProcessingWaQueue = false;
}

function safeSendMessage(jid, message) {
  return new Promise((resolve, reject) => {
    waMessageQueue.push({ jid, message, resolve, reject });
    processWaQueue();
  });
}
// ------------------------------

async function connectToWhatsApp() {

  const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
  
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' })
  });
  
  clientSocket = sock;

  sock.ev.on('creds.update', saveCreds);

  

// --- LIMITADOR DE TASA (RATE LIMIT) GLOBAL PARA GOOGLE AI ---
// Limitaremos a 10 peticiones por minuto para tener un margen contra el límite de 15 RPM
const globalAiRequests = [];

function checkAndAddAiRequest() {
  const now = Date.now();
  // Limpiar peticiones más antiguas de 1 minuto
  while (globalAiRequests.length > 0 && now - globalAiRequests[0] > 60000) {
    globalAiRequests.shift();
  }
  
  if (globalAiRequests.length >= 12) {
    return false; // Límite excedido
  }
  globalAiRequests.push(now);
  return true;
}
// -------------------------------------------------------------

  sock.ev.on('messages.upsert', async (m) => {

    try {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const remoteJid = msg.key.remoteJid;
      if (remoteJid.includes("@g.us")) return;
      const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;


      if (textMessage && textMessage.trim() !== '') {
        console.log(`[BOT] Mensaje recibido de ${remoteJid}: ${textMessage}`);
        
        if (!checkAndAddAiRequest()) {
           console.log(`[BOT] Rate limit excedido para ${remoteJid}`);
           await safeSendMessage(remoteJid, { text: "Estoy procesando demasiadas cosas a la vez en este momento, dame 1 minuto para organizar mis ideas. ⏳" });
           return;
        }

        
        

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
          await safeSendMessage(remoteJid, { text: classification.respuesta });
        } else if (classification.tipo === 'proyecto_listo') {
          activeChats.delete(remoteJid);
          await safeSendMessage(remoteJid, { text: "Gracias por la información. Hemos registrado los detalles de su proyecto y nuestro equipo comercial los revisará en breve." });
          
          
          // Buscar Líder Comercial por defecto
          const { data: liderData } = await supabase.from('usuarios').select('id, nombre, rol').eq('rol', 'Líder Comercial').limit(1);
          let encargados_default = [];
          if (liderData && liderData.length > 0) {
            encargados_default = [{ id: liderData[0].id, nombre: liderData[0].nombre, rol: 'Líder Comercial' }];
          }

          const notasFinales = (classification.notas || '') + '\n\n[DÍAS ESTIMADOS FASE ACTUAL: 3]';
          const { error: insertErr } = await supabase.from('proyectos').insert([{
            titulo: classification.titulo,
            cliente_nombre: classification.nombre_cliente,
            cliente_empresa: classification.empresa,
            cliente_telefono: classification.cliente_telefono,
            notas: notasFinales.trim(),
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



cron.schedule("0 3 * * *", async () => {
  console.log("[CRON] Ejecutando resumen diario de proyectos...");
  
  const { data: proyectos, error } = await supabase
    .from("proyectos")
    .select("*")
    .not("estado", "in", "(" + `"Entregado y cerrado"` + ", " + `"Archivado"` + ")");

  if (error || !proyectos) {
    console.error("Error al consultar proyectos para CRON:", error);
    return;
  }

  const rolesMap = {
    'Diseñador': ['en diseño'],
    'Instalador': ['instalar', 'instalación'],
    'Impresor u Operador': ['impresión', 'producción'],
    'Fabricante': ['fabricación'],
    'Líder Comercial': ['conversación', 'levantamiento', 'presupuesto', 'cobranza', 'cotización']
  };

  const hoyNorm = new Date();
  hoyNorm.setHours(0,0,0,0);

  // Extraer usuarios únicos de todos los encargados
  const userMap = new Map();
  for (const pry of proyectos) {
    if (!pry.encargados) continue;
    for (const e of pry.encargados) {
      if (e.nombre && (e.id || e.user_id)) {
         userMap.set(e.id || e.user_id, { id: e.id || e.user_id, nombre: e.nombre, rol: e.rol || 'Desconocido', telefono: e.telefono });
      }
    }
  }

  for (const usuario of userMap.values()) {
    let activosUser = [];
    let retrasadosUser = [];
    let intervencionUser = [];

    for (const pry of proyectos) {
      if (!pry.encargados) continue;

      const esEncargado = pry.encargados.some(e => e.user_id === usuario.id || e.id === usuario.id);
      if (!esEncargado) continue;

      const est = (pry.estado || '').toLowerCase();
      let requiereIntervencion = false;
      const keywords = rolesMap[usuario.rol] || [];
      if (keywords.some(kw => est.includes(kw))) {
        requiereIntervencion = true;
      }

      let retrasado = false;
      if (pry.fecha_entrega) {
        const d = new Date(pry.fecha_entrega);
        d.setHours(0, 0, 0, 0);
        if (d < hoyNorm) retrasado = true;
      }

      if (retrasado) {
        retrasadosUser.push(pry.titulo);
      } else if (requiereIntervencion) {
        intervencionUser.push(pry.titulo);
      } else {
        activosUser.push(pry.titulo);
      }
    }

    if (activosUser.length > 0 || retrasadosUser.length > 0 || intervencionUser.length > 0) {
      let resumen = `¡Buenos días, ${usuario.nombre}! ☀️\nAquí tienes el resumen de tus proyectos:\n\n`;
      if (retrasadosUser.length > 0) resumen += `❌ *RETRASADOS*:\n- ${retrasadosUser.join('\n- ')}\n\n`;
      if (intervencionUser.length > 0) resumen += `⚡ *REQUIEREN TU ATENCIÓN HOY*:\n- ${intervencionUser.join('\n- ')}\n\n`;
      if (activosUser.length > 0) resumen += `✅ *OTROS PROYECTOS ACTIVOS*:\n- ${activosUser.join('\n- ')}\n\n`;
      resumen += `¡Que tengas un excelente día de trabajo!`;

      // Enviar Push
      await enviarPushNotificacion("Tu Resumen Diario 📋", resumen, [usuario.id]);

      // Enviar WhatsApp
      let num = null;
      if (usuario.telefono) {
        num = usuario.telefono.replace(/[^0-9]/g, '');
      } else {
        const nom = usuario.nombre.toLowerCase();
        if (nom.includes("griger")) num = "584248037379";
        else if (nom.includes("idalys")) num = "584122966969";
      }
      
      // Asegurar código de país 58
      if (num) {
        if (num.startsWith('0')) num = '58' + num.substring(1);
        else if (!num.startsWith('58') && num.length === 10) num = '58' + num;
      }

      if (num && num.length >= 10) {
        try {
          if (clientSocket && waState === 'CONNECTED') {
             await safeSendMessage(`${num}@s.whatsapp.net`, { text: resumen });
             console.log(`[WHATSAPP-CRON] Resumen enviado a ${usuario.nombre} (${num})`);
          }
        } catch(e) {
          console.error(`Error WA Cron (${usuario.nombre}):`, e.message);
        }
      }
    }
  }
}, {
  timezone: "America/Caracas"
});

