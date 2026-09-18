const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf-8');

// 1. Modificar el SYSTEM PROMPT
code = code.replace(
  "Eres el asistente virtual de Global's, una agencia de publicidad y marketing en Venezuela. Tu tono debe ser estrictamente empresarial, formal, profesional y directo, evitando el exceso de amabilidad, emojis informales o charlas casuales. Tu objetivo es recabar información del cliente para generar requerimientos claros y devolver un JSON estructurado.",
  "Eres el asistente virtual de Global's, una agencia de publicidad y marketing en Venezuela. Tu tono debe ser cálido y amable, pero siempre manteniendo la profesionalidad y formalidad. Saluda y despídete con cordialidad, usando un lenguaje respetuoso. Evita usar demasiados emojis o exceso de coloquialismos. Tu objetivo es recabar información del cliente para generar requerimientos claros y devolver un JSON estructurado."
);

code = code.replace(
  "Eres el agente inteligente de ventas de la agencia de publicidad Global's.\nTu objetivo es conversar con el cliente por WhatsApp de forma amable, corta y persuasiva.",
  "Eres el asistente virtual de Global's, una agencia de publicidad y marketing en Venezuela. Tu tono debe ser cálido y amable, pero siempre manteniendo la profesionalidad y formalidad. Saluda y despídete con cordialidad, usando un lenguaje respetuoso. Evita usar demasiados emojis o exceso de coloquialismos. Tu objetivo es recabar información del cliente para generar requerimientos claros y devolver un JSON estructurado."
);

code = code.replace(
  /Caso 1:[\s\S]*?"respuesta": "Hola! 👋 Claro que sí, ¿cuéntame de qué tamaño aproximado te gustaría el letrero y a nombre de quién lo registro\? Y me podrías regalar un número de teléfono de contacto\?"\n\}/,
  "Caso 1: Si falta información (detalles, nombre, empresa, o teléfono), mantén la conversación viva para solicitar lo que falta:\n{\n  \"tipo\": \"conversacion\",\n  \"respuesta\": \"¡Hola! Con gusto le ayudamos con su requerimiento. ¿Me podría indicar las medidas aproximadas y a nombre de quién registramos la solicitud?\"\n}"
);

// 2. Implementar memoria (Historial)
// Agregar el Map al principio, debajo de const recentUpdates = new Set();
code = code.replace(
  "const recentUpdates = new Set();\n",
  "const recentUpdates = new Set();\nconst activeChats = new Map();\n"
);

// Modificar la llamada a chatSession
const historyRegex = /const chatSession = model\.startChat\(\{ history: \[\] \}\);\n\s*const result = await chatSession\.sendMessage\(textMessage\);\n\s*classification = parseClassification\(result\.response\.text\(\)\);/g;

const newHistoryLogic = `
            let userHistory = activeChats.get(remoteJid) || [];
            
            const chatSession = model.startChat({ history: userHistory });
            const result = await chatSession.sendMessage(textMessage);
            
            userHistory = await chatSession.getHistory();
            activeChats.set(remoteJid, userHistory);
            
            classification = parseClassification(result.response.text());
`;

code = code.replace(historyRegex, newHistoryLogic);

fs.writeFileSync('index.js', code);
