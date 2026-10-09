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
import { default as makeWASocket, useMultiFileAuthState, DisconnectReason, initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
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


const SYSTEM_PROMPT = `Eres el asistente virtual de Global's, una empresa que vende, crea y arma productos de publicidad exterior e interior.
Global's ofrece: vallas publicitarias, corpóreos normales e iluminados, stands, señales de tránsito e industriales, letreros, diseño de logos, identidad visual, rotulación de vehículos o cualquier cosa, impresiones en excelentes formatos (gran formato) e impresiones 3D para acabados en vallas. También hacen tótems y tienen en la ciudad diferentes espacios para vallas.
Horario de trabajo: de lunes a viernes en oficina de 8.30am a 5.30pm.

Tu tono debe ser cálido, amable, pero no demasiado amigable; Profesional y conciso, sin muchas deambulaciones. Es mejor responder mensajes cortos pero que contengan respuestas satisfactorias. Saluda y despídete con cordialidad, usando un lenguaje respetuoso. Evita usar demasiados emojis. Tu objetivo es recabar información del cliente para generar requerimientos claros, responder dudas de los clientes en base a la información de la empresa, o escalar a un humano cuando sea necesario, y devolver un JSON estructurado.

Para registrar un NUEVO pedido, NECESITAS recolectar OBLIGATORIAMENTE esta información:
1. Qué servicio/producto necesita y sus detalles básicos (medidas, material).
2. El Cliente (Nombre de la empresa o negocio, Ej: Hato Grill, Ferretería El Sol).
3. La Persona de Contacto (Nombre de la persona con la que hablas, Ej: Juan Pérez).
4. El Número de teléfono de la persona de contacto (pídelo explícitamente para guardarlo en la ficha).

REGLAS ESTRICTAS DE RESPUESTA:
Debes responder SIEMPRE y ÚNICAMENTE con un objeto JSON válido (sin formato markdown ni texto extra).

Caso 1: Si falta información (detalles, empresa, persona de contacto, o teléfono) para registrar un nuevo pedido, o estás respondiendo una duda, mantén la conversación viva:
{
  "tipo": "conversacion",
  "respuesta": "¡Hola! Con gusto le ayudamos con su requerimiento. ¿Me podría indicar a nombre de qué empresa o negocio lo registramos y el nombre de la persona de contacto?"
}

Caso 2: Si el usuario hace una pregunta extensa, compleja, o dice que quiere hablar con un humano o asesor, o no sabes qué responder de forma concisa:
{
  "tipo": "escalar",
  "respuesta": "Entendido. Un asesor o líder comercial revisará tu caso y te responderá en breve. Por favor, mantente a la espera."
}

Caso 3: Si el usuario solo está agradeciendo, diciendo 'ok', 'vale', o despidiéndose (después de que ya registraste su pedido o durante la charla), o si YA creaste el proyecto en mensajes anteriores, NO pidas más datos ni envíes proyecto_listo de nuevo, solo despídete amablemente:
{
  "tipo": "conversacion",
  "respuesta": "Entendido. La información ha sido registrada. Un miembro de nuestro equipo comercial se comunicará a la brevedad posible."
}

Caso 4: Si ya tienes los detalles del pedido, la persona de contacto, el TELÉFONO y el cliente/empresa (o si dijo que no tiene empresa) y es el momento de crear el proyecto en el sistema:
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
const humanPausedChats = new Map();

const useSupabaseAuthState = async (supabaseClient, tableName = 'whatsapp_auth') => {
  const writeData = async (data, id) => {
    try {
      const jsonStr = JSON.stringify(data, BufferJSON.replacer);
      const jsonObj = JSON.parse(jsonStr);
      await supabaseClient.from(tableName).upsert({ id, data: jsonObj });
    } catch (e) {
      console.error('Error guardando auth en Supabase', e);
    }
  };

  const readData = async (id) => {
    try {
      const { data, error } = await supabaseClient.from(tableName).select('data').eq('id', id).single();
      if (error || !data) return null;
      const jsonStr = JSON.stringify(data.data);
      return JSON.parse(jsonStr, BufferJSON.reviver);
    } catch (e) {
      console.error('Error leyendo auth en Supabase', e);
      return null;
    }
  };

  const removeData = async (id) => {
    await supabaseClient.from(tableName).delete().eq('id', id);
  };

  const creds = await readData('creds') || initAuthCreds();
  const keysCache = new Map();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              const key = `${type}-${id}`;
              let value;
              if (keysCache.has(key)) {
                value = keysCache.get(key);
              } else {
                value = await readData(key);
                if (value) keysCache.set(key, value);
              }
              
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) {
                keysCache.set(key, value);
                tasks.push(writeData(value, key));
              } else {
                keysCache.delete(key);
                tasks.push(removeData(key));
              }
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => {
      return writeData(creds, 'creds');
    }
  };
};




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
        
        if (num) {
           if (num.startsWith('0')) num = '58' + num.substring(1);
           else if (!num.startsWith('58') && num.length === 10) num = '58' + num;
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
    // Buscar encargados eliminados
    const eliminados = oldEnc.filter(o => !newEnc.some(n => (n.user_id && n.user_id === o.user_id) || (n.id && n.id === o.id) || (n.nombre === o.nombre)));

    if (eliminados.length > 0) {
      console.log(`[👥 ENCARGADO ELIMINADO] En proyecto "${newRecord.titulo}"`);
      for (const enc of eliminados) {
        if (enc.user_id || enc.id) {
          await enviarPushNotificacion("Fuiste removido del proyecto", `Has sido removido del proyecto: ${newRecord.titulo}`, [enc.user_id || enc.id]);
        }
        let num = null;
        if (enc.telefono) num = enc.telefono.replace(/[^0-9]/g, '');
        else {
           const nom = enc.nombre ? enc.nombre.toLowerCase() : '';
           if (nom.includes("griger")) num = "584248037379";
           else if (nom.includes("idalys")) num = "584122966969";
        }
        if (num) {
           if (num.startsWith('0')) num = '58' + num.substring(1);
           else if (!num.startsWith('58') && num.length === 10) num = '58' + num;
        }
        if (num && num.length >= 10) {
           try {
             if (clientSocket && waState === 'CONNECTED') {
                await safeSendMessage(`${num}@s.whatsapp.net`, { text: `📌 *Removido del Proyecto*\nHas sido removido del proyecto: *${newRecord.titulo}*.` });
             }
           } catch(e) {}
        }
      }
    }

    const notifsToEncargados = [];

    const isSilencedState = (estado) => {
      if (!estado) return false;
      const lower = estado.toLowerCase();
      return lower.includes('archivado') || lower.includes('cancelado') || lower.includes('pausa') || lower.includes('detenido') || lower.includes('ocult');
    };

    const isCurrentlySilenced = isSilencedState(newRecord.estado);

    // Título
    if (!isCurrentlySilenced && oldRecord.titulo !== newRecord.titulo) {
      notifsToEncargados.push(`✏️ El proyecto cambió su nombre de "${oldRecord.titulo}" a "${newRecord.titulo}"`);
    }

    // Estado (Mover, Retrasar, Pausar/Archivar/Cancelar)
    if (oldRecord.estado !== newRecord.estado) {
      const dedupeKey = `${newRecord.id}-${newRecord.estado}`;
      if (!recentUpdates.has(dedupeKey)) {
        recentUpdates.add(dedupeKey);
        setTimeout(() => recentUpdates.delete(dedupeKey), 5000);

        console.log(`[🔄 CAMBIO DE ESTADO] Proyecto "${newRecord.titulo}" -> "${newRecord.estado}"`);
        
        const estLower = (newRecord.estado || '').toLowerCase();
        
        if (!estLower.includes('ocult')) {
          if (estLower.includes('archivado') || estLower.includes('cancelado') || estLower.includes('pausa') || estLower.includes('detenido')) {
            notifsToEncargados.push(`🛑 El proyecto "${newRecord.titulo}" pasó a estado: ${newRecord.estado}.\nMotivo: ${newRecord.motivo_cancelacion || 'No especificado'}`);
          } else if (newRecord.motivo_cancelacion && oldRecord.motivo_cancelacion !== newRecord.motivo_cancelacion) {
            notifsToEncargados.push(`⚠️ El proyecto "${newRecord.titulo}" retrocedió a la columna ${newRecord.estado}.\nMotivo: ${newRecord.motivo_cancelacion}`);
          } else {
            notifsToEncargados.push(`🔄 El proyecto "${newRecord.titulo}" fue movido a la columna: ${newRecord.estado}`);
          }

          // Notificar cliente solo si no se archiva
          if (newRecord.estado !== 'Archivado' && newRecord.cliente_telefono) {
            const numeroLimpiado = newRecord.cliente_telefono.replace(/[^0-9]/g, '');
            if (numeroLimpiado.length >= 10) {
              const mensaje = `¡Hola! Te escribimos de Global's para informarte que tu proyecto *"${newRecord.titulo}"* ha sido movido a la fase: *${newRecord.estado}*.\n\nTe seguiremos informando.`;
              try {
                if (clientSocket && waState === 'CONNECTED') {
                   // safeSendMessage(chatId, { text: mensaje })
                }
              } catch (err) {}
            }
          }
        }
      }
    }

    // Levantamiento
    if (!isCurrentlySilenced && !oldRecord.levantamiento_fecha && newRecord.levantamiento_fecha) {
       notifsToEncargados.push(`📋 Se llenó la hoja de levantamiento para el proyecto "${newRecord.titulo}"`);
    }

    // Notas
    if (!isCurrentlySilenced && oldRecord.notas !== newRecord.notas) {
       notifsToEncargados.push(`📝 Se agregaron/modificaron las notas en el proyecto "${newRecord.titulo}"`);
    }

    if (notifsToEncargados.length > 0 && newRecord.encargados && newRecord.encargados.length > 0) {
      const pushMsg = notifsToEncargados.join('\n\n');
      const userIds = newRecord.encargados.filter(e => (e.user_id || e.id)).map(e => (e.user_id || e.id));
      
      if (userIds.length > 0) {
        setTimeout(async () => {
          await enviarPushNotificacion("Actualización de Proyecto", pushMsg, userIds);
        }, 5000);
      }
      
      for (const encargado of newRecord.encargados) {
        if (!encargado.nombre) continue;
        
        let num = null;
        if (encargado.telefono) {
          num = encargado.telefono.replace(/[^0-9]/g, '');
        } else {
          const nom = encargado.nombre.toLowerCase();
          if (nom.includes("griger")) num = "584248037379";
          else if (nom.includes("idalys")) num = "584122966969";
        }
        
        if (num) {
           if (num.startsWith('0')) num = '58' + num.substring(1);
           else if (!num.startsWith('58') && num.length === 10) num = '58' + num;
        }
        
        if (num && num.length >= 10) {
          try {
            if (clientSocket && waState === 'CONNECTED') {
              await safeSendMessage(`${num}@s.whatsapp.net`, { text: `⚠️ *Actualización de Proyecto*\n\n${pushMsg}` });
              console.log(`[WHATSAPP] Notificación enviada a encargado ${encargado.nombre} (${num})`);
            }
          } catch (err) {
            console.error(`❌ Error al enviar aviso WA a encargado ${encargado.nombre}:`, err.message);
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
      let autorMostrar = newComment.autor_nombre || newComment.autor_email || "Usuario";
      
      // Intentar obtener el nombre del autor a partir de los encargados
      if (!newComment.autor_nombre && newComment.autor_email && proyecto.encargados) {
        const match = proyecto.encargados.find(e => e.email === newComment.autor_email || e.id === newComment.autor_email || e.user_id === newComment.autor_email);
        if (match && match.nombre) autorMostrar = match.nombre;
      }
      
      // Fallback: si sigue siendo un email, limpiar un poco
      if (autorMostrar.includes('@') && autorMostrar === newComment.autor_email) {
        autorMostrar = autorMostrar.split('@')[0];
        autorMostrar = autorMostrar.charAt(0).toUpperCase() + autorMostrar.slice(1);
      }

      // No enviar push al autor del comentario
      const userIds = proyecto.encargados
        .filter(e => {
           const eId = e.user_id || e.id;
           const isAuthor = (e.email === newComment.autor_email) || (e.nombre === autorMostrar) || (eId === newComment.autor_email);
           return eId && !isAuthor;
        })
        .map(e => (e.user_id || e.id));

      const pushMsg = `${autorMostrar} comentó en ${proyecto.titulo}: "${newComment.texto.substring(0, 50)}..."`;
      
      if (userIds.length > 0) {
        await enviarPushNotificacion("Nuevo Comentario", pushMsg, userIds);
      }

      let waText = `💬 *Nuevo comentario en "${proyecto.titulo}"*\n👤 *Por:* ${autorMostrar}\n\n"${newComment.texto}"\n\n💡 _Recuerda responder o revisar esto directamente desde la app._`;
      
      for (const encargado of proyecto.encargados) {
         const isAuthor = (encargado.email === newComment.autor_email) || (encargado.nombre === autorMostrar) || ((encargado.user_id || encargado.id) === newComment.autor_email);
         if (!encargado.nombre || isAuthor) continue;
         
         let num = null;
         if (encargado.telefono) {
           num = encargado.telefono.replace(/[^0-9]/g, '');
         } else {
           const nom = encargado.nombre.toLowerCase();
           if (nom.includes("griger")) num = "584248037379";
           else if (nom.includes("idalys")) num = "584122966969";
         }

         if (num) {
            if (num.startsWith('0')) num = '58' + num.substring(1);
            else if (!num.startsWith('58') && num.length === 10) num = '58' + num;
         }

         if (num && num.length >= 10) {
           try {
             if (clientSocket && waState === 'CONNECTED') {
               await safeSendMessage(`${num}@s.whatsapp.net`, { text: waText });
             }
           } catch (err) {
             console.error(`Error WA Comentario a ${encargado.nombre}:`, err.message);
           }
         }
      }
    }
  })
  .subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      console.log('Backend suscrito a nuevos comentarios');
    }
  });




let clientSocket = null;
const botSentMessageIds = new Set();

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
        if (result?.key?.id) {
          botSentMessageIds.add(result.key.id);
          // Eliminar el ID después de 10 minutos para liberar memoria
          setTimeout(() => botSentMessageIds.delete(result.key.id), 10 * 60 * 1000);
        }
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

  const { state, saveCreds } = await useSupabaseAuthState(supabase, 'whatsapp_auth');
  
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
      if (!msg.message) return;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid.includes("@g.us") || remoteJid === 'status@broadcast') return;
      const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;

      if (!textMessage || textMessage.trim() === '') return;

      if (msg.key.fromMe) {
        if (botSentMessageIds.has(msg.key.id)) {
          // Fue enviado por el propio bot. Lo ignoramos.
          return;
        }

        // Humano respondió manualmente desde el teléfono/web
        let userHistory = activeChats.get(remoteJid) || [];
        userHistory.push({ role: "model", parts: [{ text: textMessage }] });
        activeChats.set(remoteJid, userHistory);
        
        humanPausedChats.set(remoteJid, Date.now() + 2 * 60 * 60 * 1000);
        console.log(`[BOT] Humano respondió a ${remoteJid}. Bot pausado por 2 horas.`);
        return;
      }

      // Check si el bot está pausado
      const pauseUntil = humanPausedChats.get(remoteJid);
      if (pauseUntil && Date.now() < pauseUntil) {
         console.log(`[BOT] Bot en pausa para ${remoteJid}, ignorando mensaje del cliente...`);
         let userHistory = activeChats.get(remoteJid) || [];
         userHistory.push({ role: "user", parts: [{ text: textMessage }] });
         activeChats.set(remoteJid, userHistory);
         return;
      } else if (pauseUntil) {
         humanPausedChats.delete(remoteJid);
      }

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
        } else if (classification.tipo === 'escalar') {
          await safeSendMessage(remoteJid, { text: classification.respuesta });
          // Pausar bot hasta que un humano responda
          humanPausedChats.set(remoteJid, Date.now() + 2 * 60 * 60 * 1000);
          console.log(`[BOT] Conversación escalada para ${remoteJid}. Bot pausado.`);
          
          // Notificar Líder Comercial
          const { data: _allEmps } = await supabase.rpc('get_empleados');
          if (_allEmps) {
             const lideres = _allEmps.filter(e => e.rol === 'Líder Comercial');
             for (const lider of lideres) {
                await enviarPushNotificacion("¡Atención Requerida!", `El bot escaló la conversación con ${phoneNumber}`, [lider.id]);
                let num = lider.telefono ? lider.telefono.replace(/[^0-9]/g, '') : null;
                if (!num && lider.nombre.toLowerCase().includes("griger")) num = "584248037379";
                if (!num && lider.nombre.toLowerCase().includes("idalys")) num = "584122966969";
                if (num) {
                   if (num.startsWith('0')) num = '58' + num.substring(1);
                   else if (!num.startsWith('58') && num.length === 10) num = '58' + num;
                   await safeSendMessage(`${num}@s.whatsapp.net`, { text: `🚨 *Atención Requerida*\nEl bot no supo cómo responder o el cliente pidió un asesor.\n\n👤 *Cliente:* ${phoneNumber}\nÚltimo mensaje: "${textMessage}"\n\nPor favor atiende el chat manualmente. El bot está pausado para este chat por 2 horas.` });
                }
             }
          }
        } else if (classification.tipo === 'proyecto_listo') {
          activeChats.delete(remoteJid);
          await safeSendMessage(remoteJid, { text: "Gracias por la información. Hemos registrado los detalles de su proyecto y nuestro equipo comercial los revisará en breve." });
          
          
          // Buscar Líder Comercial por defecto
          const { data: _allEmps } = await supabase.rpc('get_empleados');
          let encargados_default = [];
          if (_allEmps) {
             const lideres = _allEmps.filter(e => e.rol === 'Líder Comercial');
             if (lideres.length > 0) {
                encargados_default = [{ id: lideres[0].id, nombre: lideres[0].nombre, rol: 'Líder Comercial', email: lideres[0].email, telefono: lideres[0].telefono }];
             }
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
        console.log('[WHATSAPP] Sesión cerrada (loggedOut). Borrando credenciales en Supabase y reiniciando...');
        waState = 'DISCONNECTED';
        try {
          await supabase.from('whatsapp_auth').delete().neq('id', 'nada');
        } catch(err) {
          console.error('Error al borrar auth en Supabase:', err);
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

// Added 9am Cron for Estancados
cron.schedule("0 9 * * *", async () => {
  console.log("[CRON 9AM] Verificando proyectos estancados...");

  const { data: proyectos, error } = await supabase
    .from("proyectos")
    .select("*")
    .not("estado", "in", "(" + `"Entregado y cerrado"` + ", " + `"Archivado"` + ", " + `"Cancelado"` + ")");

  if (error || !proyectos) {
    console.error("Error al consultar proyectos para CRON 9AM:", error);
    return;
  }

  const hoyNorm = new Date();
  hoyNorm.setHours(0,0,0,0);

  for (const pry of proyectos) {
    if (pry.estado?.toLowerCase().includes('pausa')) continue;
    if (!pry.encargados || pry.encargados.length === 0) continue;

    let diasTotales = 2; // default
    if (pry.notas) {
      const match = pry.notas.match(/\[DÍAS ESTIMADOS FASE ACTUAL:\s*(\d+)\]/i);
      if (match) diasTotales = parseInt(match[1], 10);
    }

    const fechaUltima = new Date(pry.fecha_ultima_actualizacion || pry.fecha_creacion);
    fechaUltima.setHours(0,0,0,0);
    const deadlineFase = new Date(fechaUltima);
    deadlineFase.setDate(deadlineFase.getDate() + diasTotales);

    const diffFase = Math.round((deadlineFase - hoyNorm) / (1000 * 60 * 60 * 24));

    let msj = "";
    if (diffFase === 1) {
       msj = `⚠️ *ALERTA DE FASE*\nMañana se vence el tiempo estimado para la fase "${pry.estado}" del proyecto "${pry.titulo}". ¡Trata de avanzarlo hoy!`;
    } else if (diffFase <= 0) {
       const diasAtraso = Math.abs(diffFase);
       msj = `⏳ *PROYECTO ESTANCADO*\nEl proyecto "${pry.titulo}" lleva estancado en la fase "${pry.estado}" por ${diasAtraso === 0 ? 'hoy' : `${diasAtraso} días más de lo previsto`}. ¡Requiere tu acción!`;
    }

    if (msj) {
      const userIds = pry.encargados.filter(e => (e.user_id || e.id)).map(e => (e.user_id || e.id));
      if (userIds.length > 0) {
        await enviarPushNotificacion(diffFase === 1 ? "⚠️ Alerta de Fase" : "⏳ Proyecto Estancado", msj, userIds);
      }

      for (const encargado of pry.encargados) {
        if (!encargado.nombre) continue;
        let num = null;
        if (encargado.telefono) {
          num = encargado.telefono.replace(/[^0-9]/g, '');
        } else {
          const nom = encargado.nombre.toLowerCase();
          if (nom.includes("griger")) num = "584248037379";
          else if (nom.includes("idalys")) num = "584122966969";
        }
        
        if (num) {
           if (num.startsWith('0')) num = '58' + num.substring(1);
           else if (!num.startsWith('58') && num.length === 10) num = '58' + num;
        }

        if (num && num.length >= 10) {
          try {
            if (clientSocket && waState === 'CONNECTED') {
              await safeSendMessage(`${num}@s.whatsapp.net`, { text: msj });
            }
          } catch (err) {}
        }
      }
    }
  }
}, {
  timezone: "America/Caracas"
});
