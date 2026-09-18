const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf-8');

// 1. Bot tone
code = code.replace(
  "Eres el asistente virtual de Global's (una empresa de publicidad y marketing en Venezuela). Tu objetivo es atender a los clientes de manera muy amable y resumir lo que necesitan en un JSON para crear un proyecto.",
  "Eres el asistente virtual de Global's, una agencia de publicidad y marketing en Venezuela. Tu tono debe ser estrictamente empresarial, formal, profesional y directo, evitando el exceso de amabilidad, emojis informales o charlas casuales. Tu objetivo es recabar información del cliente para generar requerimientos claros y devolver un JSON estructurado."
);
code = code.replace(
  `"respuesta": "¡De nada! Quedamos a tu entera disposición. Un miembro de nuestro equipo te escribirá pronto."`,
  `"respuesta": "Entendido. La información ha sido registrada. Un miembro de nuestro equipo comercial se comunicará a la brevedad posible."`
);
code = code.replace(
  `"respuesta": "Lo siento, no entendí bien. ¿Podrías repetirlo?"`,
  `"respuesta": "La información proporcionada no es clara. Por favor, reestructure su requerimiento para poder procesarlo correctamente."`
);

// 2. Change wording "avanzó a" to "fue movido a la columna"
code = code.replace(
  /ha avanzado a la etapa: \*\$\{newRecord\.estado\}\*/g,
  "ha sido movido a la columna: *${newRecord.estado}*"
);
code = code.replace(
  /avanzó a: " \+ newRecord\.estado/g,
  "fue movido a la columna: \" + newRecord.estado"
);

// 3. Disable client notification
code = code.replace(
  /clientSocket\.sendMessage\(chatId, \{ text: mensaje \}\)/g,
  "// clientSocket.sendMessage(chatId, { text: mensaje })"
);

// 4. Add bot listener inside connectToWhatsApp
const botListener = `
  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const remoteJid = msg.key.remoteJid;
      const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;

      if (textMessage && textMessage.trim() !== '') {
        console.log(\`[BOT] Mensaje recibido de \${remoteJid}: \${textMessage}\`);
        
        const chatSession = model.startChat({
          history: [] 
        });

        const result = await chatSession.sendMessage(textMessage);
        const classification = parseClassification(result.response.text());

        if (classification.tipo === 'conversacion') {
          await sock.sendMessage(remoteJid, { text: classification.respuesta });
        } else if (classification.tipo === 'proyecto_listo') {
          await sock.sendMessage(remoteJid, { text: "Gracias por la información. Hemos registrado los detalles de su proyecto y nuestro equipo comercial los revisará en breve." });
          
          await supabase.from('proyectos').insert([{
            titulo: classification.titulo,
            nombre_cliente: classification.nombre_cliente,
            empresa: classification.empresa,
            cliente_telefono: classification.cliente_telefono,
            notas: classification.notas,
            estado: classification.estado || 'En Conversación',
            fecha_entrega: null
          }]);
          console.log('[BOT] Proyecto creado en base de datos desde WhatsApp');
        }
      }
    } catch (err) {
      console.error('[BOT] Error procesando mensaje entrante:', err);
    }
  });
`;

code = code.replace(
  /sock\.ev\.on\('connection\.update', async \(update\) => \{/,
  botListener + "\n  sock.ev.on('connection.update', async (update) => {"
);

fs.writeFileSync('index.js', code);
