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
import qrcode from 'qrcode-terminal';
import pkg from 'whatsapp-web.js';

const { Client, LocalAuth } = pkg;

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

  const tokens = data.map(d => d.token);
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


const SYSTEM_PROMPT = `Eres el agente inteligente de ventas de la agencia de publicidad Global's.
Tu objetivo es conversar con el cliente por WhatsApp de forma amable, corta y persuasiva.
Para registrar el pedido, NECESITAS recolectar OBLIGATORIAMENTE esta información:
1. Qué servicio/producto necesita y sus detalles básicos (medidas, material).
2. El Nombre del cliente.
3. El Número de teléfono (pídelo explícitamente para guardarlo en la ficha).
4. El Nombre de su Empresa (opcional, si aplica).

REGLAS ESTRICTAS DE RESPUESTA:
Debes responder SIEMPRE y ÚNICAMENTE con un objeto JSON válido (sin formato markdown ni texto extra).

Caso 1: Si falta información (detalles, nombre, o teléfono), mantén la conversación viva:
{
  "tipo": "conversacion",
  "respuesta": "Hola! 👋 Claro que sí, ¿cuéntame de qué tamaño aproximado te gustaría el letrero y a nombre de quién lo registro? Y me podrías regalar un número de teléfono de contacto?"
}

Caso 2: Si el usuario solo está agradeciendo, diciendo 'ok', 'vale', o despidiéndose (después de que ya registraste su pedido o durante la charla), o si YA creaste el proyecto en mensajes anteriores, NO pidas más datos ni envíes proyecto_listo de nuevo, solo despídete amablemente:
{
  "tipo": "conversacion",
  "respuesta": "¡De nada! Quedamos a tu entera disposición. Un miembro de nuestro equipo te escribirá pronto."
}

Caso 3: Si ya tienes los detalles del pedido, su nombre, TELÉFONO y empresa (o si dijo que no tiene empresa) y es el momento de crear el proyecto en el sistema:
{
  "tipo": "proyecto_listo",
  "titulo": "Resumen corto (Ej: Letrero Luminoso 2x1)",
  "nombre_cliente": "Juan Pérez",
  "empresa": "Ferretería El Sol",
  "cliente_telefono": "0987654321",
  "notas": "Descripción completa de lo que pidió el cliente",
  "estado": "En Conversación"
}`;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-3.6-flash',
  systemInstruction: SYSTEM_PROMPT,
  generationConfig: {
    responseMimeType: 'application/json',
  },
});

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


app.get('/api/whatsapp/status', (_req, res) => {
  res.json({
    status: waState,
    qr: latestQrDataUrl
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: resolveChromePath(),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--no-first-run',
      '--disable-software-rasterizer',
      '--disable-background-timer-throttling',
      '--js-flags=--max-old-space-size=128',
    ],
  },
});

client.on('qr', async (qr) => {
  console.log('[WHATSAPP] QR Event recibido.');
  waState = 'QR_READY';
  try {
    latestQrDataUrl = await qrcodeData.toDataURL(qr);
  } catch(e) {
    console.error('Error al generar QR data URL:', e);
  }

  console.log('=========================================');
  console.log('Escanea este QR con WhatsApp para conectar el backend:');
  qrcode.generate(qr, { small: true }, (qrStr) => { fs.writeFileSync('qr.txt', qrStr); console.log(qrStr); });
  console.log('=========================================');
});

client.on('ready', () => {
  waState = 'CONNECTED';
  latestQrDataUrl = null;

  console.log('Cliente de WhatsApp listo y escuchando mensajes!');
});

const chatMemory = new Map();

client.on('message_create', async (message) => {
  try {
    console.log(`[🔍 ESPÍA] De: ${message.from} | Texto: "${message.body}"`);
    
    if (message.fromMe) return;
    
    // Helper para obtener el ID de un grupo o chat
    if (message.body.trim() === '!id') {
      await message.reply(`El ID de este chat/grupo es: ${message.from}`);
      return;
    }

    if (message.from.endsWith('@g.us')) return; // Ignora el resto de grupos
    if (message.from === 'status@broadcast') return; // Ignora los Estados/Historias

    const text = (message.body || '').trim();
    if (!text) return;

    // 1. Manejo de Historial en Memoria (Súper rápido y sin errores de librería)
    const chatId = message.from;
    if (!chatMemory.has(chatId)) {
      chatMemory.set(chatId, []);
    }
    const history = chatMemory.get(chatId);
    history.push(`Cliente: ${text}`);

    // Limitar memoria a últimos 10 mensajes para no saturar
    if (history.length > 10) history.shift();

    let historialTexto = "HISTORIAL DE CONVERSACIÓN RECIENTE:\n" + history.join('\n');
    historialTexto += `\n\nINSTRUCCIÓN: Responde al último mensaje usando el JSON requerido.`;

    // 2. Clasificar / Conversar con Gemini (con reintentos en caso de fallo de red)
    let raw = "";
    let intentos = 0;
    while (intentos < 3) {
      try {
        const result = await model.generateContent(historialTexto);
        raw = result.response.text();
        break; // Éxito
      } catch (err) {
        intentos++;
        console.error(`⚠️ Fallo de red con Gemini (intento ${intentos}/3):`, err.message);
        if (intentos === 3) throw err;
        await new Promise(r => setTimeout(r, 2000)); // Esperar 2s antes de reintentar
      }
    }
    
    const iaResponse = parseClassification(raw);

    console.log('🤖 Decisión de Gemini:', iaResponse);

    // 3. Tomar acción
    if (iaResponse.tipo === 'conversacion') {
      history.push(`Asistente: ${iaResponse.respuesta}`);
      await message.reply(iaResponse.respuesta);
    } 
    else if (iaResponse.tipo === 'proyecto_listo') {
      
      // Obtener el número REAL del cliente, porque message.from puede ser un @lid
      let telefonoWS = iaResponse.cliente_telefono || chatId.split('@')[0];

      // Guardaremos Nombre y Empresa de manera bonita dentro de las Notas 
      // (así evitamos crashear si las columnas aún no existen en Supabase)
      const nombreCliente = iaResponse.nombre_cliente || 'No especificado';
      const empresaCliente = iaResponse.empresa || 'No especificada';
      
      const notasFormateadas = `👤 Cliente: ${nombreCliente}\n🏢 Empresa: ${empresaCliente}\n\n[Detalles del Pedido]\n${iaResponse.notas}`;

      const { error: dbError } = await supabase.from('proyectos').insert([
        {
          titulo: iaResponse.titulo,
          cliente_telefono: telefonoWS,
          notas: notasFormateadas,
          estado: iaResponse.estado || 'En Conversación',
          orden: 999,
          encargados: [{ nombre: 'Asignar', rol: 'Líder Comercial' }]
        },
      ]);

      if (dbError) {
        console.error('Error al guardar en Supabase:', dbError.message);
        await message.reply("Hubo un problema interno, un humano te atenderá.");
      } else {
        console.log('✅ Proyecto creado con éxito.');
        await message.reply(`¡Perfecto! Hemos registrado tu solicitud sobre "${iaResponse.titulo}".\nUn miembro de nuestro equipo te contactará muy pronto para continuar.`);
        // Limpiamos la memoria porque ya se creó el proyecto
        history.push(`Asistente: ¡Perfecto! Hemos registrado tu solicitud sobre "${iaResponse.titulo}".\nUn miembro de nuestro equipo te contactará muy pronto para continuar.`);
        if (history.length > 15) history.splice(0, history.length - 10);
      }
    }
  } catch (error) {
    if (error.status === 429) {
      console.log('⏳ Límite de Gemini alcanzado (5 por minuto). Esperando a que se enfríe...');
      // Opcional: Podrías hacer que el bot responda un mensaje genérico sin IA
      // await message.reply("¡Hola! Hemos recibido tu mensaje. Un agente te atenderá en breve.");
    } else {
      console.error('Error al procesar el mensaje:', error);
    }
  }
});

// ==========================================
// 4. Escuchar cambios de estado en Supabase
// ==========================================
supabase
  .channel('backend-estado-updates')
  .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'proyectos' }, async (payload) => {
    const oldRecord = payload.old;
    const newRecord = payload.new;

    // Solo notificar si el estado cambió, no es 'Archivado' y tenemos teléfono
    if (oldRecord.estado !== newRecord.estado && newRecord.estado !== 'Archivado' && newRecord.cliente_telefono) {
      console.log(`[🔄 CAMBIO DE ESTADO] Proyecto "${newRecord.titulo}" -> "${newRecord.estado}"`);
      
      const numeroLimpiado = newRecord.cliente_telefono.replace(/[^0-9]/g, '');
      
      // Validación básica para saber si es un número válido de WhatsApp (al menos 10 dígitos)
      if (numeroLimpiado.length >= 10) {
        const mensaje = `¡Hola! Te escribimos de Global's para informarte que tu proyecto *"${newRecord.titulo}"* ha avanzado a la etapa: *${newRecord.estado}*.\n\nTe seguiremos informando.`;
        
        try {
          const chatId = `${numeroLimpiado}@c.us`;
          // COMENTADO TEMPORALMENTE PARA EVITAR RIESGOS DE BANEO:
          // await client.sendMessage(chatId, mensaje);
          // console.log(`✅ Notificación enviada a ${numeroLimpiado}`);
          console.log(`[SIMULACIÓN] Mensaje que se habría enviado a ${numeroLimpiado}: ${mensaje}`);
        } catch (err) {
          console.error(`❌ Error al enviar aviso a ${numeroLimpiado}:`, err.message);
        }
      }

      // Enviar notificaciones PUSH y WA a los encargados
      if (newRecord.encargados && newRecord.encargados.length > 0) {
        const userIds = newRecord.encargados.filter(e => e.user_id).map(e => e.user_id);
        const pushMsg = "El proyecto " + newRecord.titulo + " avanzó a: " + newRecord.estado;
        
        if (userIds.length > 0) {
          await enviarPushNotificacion("Actualización de Proyecto", pushMsg, userIds);
        }
        
        // Enviar WA a encargados mapeados (con delay de 60s)
        for (const encargado of newRecord.encargados) {
          if (!encargado.nombre) continue;
          let num = null;
          const nom = encargado.nombre.toLowerCase();
          if (nom.includes("griger")) num = "584248037379";
          else if (nom.includes("idalys")) num = "584122966969";
          
          if (num) {
            try {
              await client.sendMessage(`${num}@c.us`, `⚠️ *Actualización de Proyecto*\n${pushMsg}`);
              console.log(`[WHATSAPP] Notificación enviada a encargado ${encargado.nombre} (${num})`);
              await sleep(60000); // 60s delay
            } catch (err) {
              console.error(`❌ Error al enviar aviso WA a encargado ${encargado.nombre}:`, err.message);
            }
          }
        }
      }
    }
  })
  .subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      console.log('Backend suscrito a cambios de estado en Supabase');
    }
  });

client.initialize();

app.listen(PORT, () => {
  console.log(`Servidor Express escuchando en http://localhost:${PORT}`);
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
        msj = `⚠️ *RECORDATORIO*\nEl proyecto "${pry.titulo}" se debe entregar MAÑANA (${fechaEntrega.toLocaleDateString()}).\nFase actual: ${pry.estado}`;
        necesitaAlerta = true;
      } else if (diffDays === 0) {
        msj = `🚨 *ENTREGA HOY*\nEl proyecto "${pry.titulo}" se debe entregar HOY.\nFase actual: ${pry.estado}`;
        necesitaAlerta = true;
      } else if (diffDays < 0) {
        msj = `⚠️ *ALERTA DE RETRASO*\nEl proyecto "${pry.titulo}" debió entregarse el ${fechaEntrega.toLocaleDateString()}.\nFase actual: ${pry.estado}`;
        necesitaAlerta = true;
      }
    }
    
    if (!necesitaAlerta && pry.fecha_ultima_actualizacion) {
      const fechaUltima = new Date(pry.fecha_ultima_actualizacion);
      fechaUltima.setHours(0,0,0,0);
      const diasEstancado = Math.floor((hoyNorm - fechaUltima) / (1000 * 60 * 60 * 24));
      if (diasEstancado >= 3) {
        msj = `⏳ *PROYECTO ESTANCADO*\nEl proyecto "${pry.titulo}" lleva ${diasEstancado} días sin avanzar.\nFase actual: ${pry.estado}`;
        necesitaAlerta = true;
      }
    }

    if (necesitaAlerta) {
      alertas.push({
        proyecto: pry.titulo,
        mensaje: msj,
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
    const pushUserIds = alerta.encargados.filter(e => e.user_id).map(e => e.user_id);
    if (pushUserIds.length > 0) {
      await enviarPushNotificacion("⚠️ Alerta de Proyecto", alerta.mensaje, pushUserIds);
    }

    for (const encargado of alerta.encargados) {
      if (!encargado.nombre) continue;
      
      let num = null;
      const nom = encargado.nombre.toLowerCase();
      if (nom.includes("griger")) num = "584248037379";
      else if (nom.includes("idalys")) num = "584122966969";

      if (num) {
        try {
          await client.sendMessage(`${num}@c.us`, alerta.mensaje);
          console.log(`[WHATSAPP-CRON] Mensaje enviado a ${encargado.nombre} (${num})`);
          await sleep(15000);
        } catch(e) {
          console.error(`Error WA Cron (${encargado.nombre}):`, e.message);
        }
      }
    }
  }
});


