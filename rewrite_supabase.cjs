const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf-8');

const listener = `
const recentUpdates = new Set();

supabase
  .channel('backend-estado-updates')
  .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'proyectos' }, async (payload) => {
    const oldRecord = payload.old;
    const newRecord = payload.new;

    // Solo notificar si el estado cambió, no es 'Archivado' y tenemos teléfono
    if (oldRecord.estado !== newRecord.estado && newRecord.estado !== 'Archivado' && newRecord.cliente_telefono) {
      
      // Evitar doble evento (deduplicación por 5 segundos)
      const dedupeKey = \`\${newRecord.id}-\${newRecord.estado}\`;
      if (recentUpdates.has(dedupeKey)) {
        console.log(\`[DEDUPE] Saltando evento duplicado para \${dedupeKey}\`);
        return;
      }
      recentUpdates.add(dedupeKey);
      setTimeout(() => recentUpdates.delete(dedupeKey), 5000);

      console.log(\`[🔄 CAMBIO DE ESTADO] Proyecto "\${newRecord.titulo}" -> "\${newRecord.estado}"\`);
      
      const numeroLimpiado = newRecord.cliente_telefono.replace(/[^0-9]/g, '');
      
      // Validación básica para saber si es un número válido de WhatsApp (al menos 10 dígitos)
      if (numeroLimpiado.length >= 10) {
        const mensaje = \`¡Hola! Te escribimos de Global's para informarte que tu proyecto *"\${newRecord.titulo}"* ha avanzado a la etapa: *\${newRecord.estado}*.\\n\\nTe seguiremos informando.\`;
        
        try {
          const chatId = \`\${numeroLimpiado}@s.whatsapp.net\`;
          if (clientSocket && waState === 'CONNECTED') {
             await clientSocket.sendMessage(chatId, { text: mensaje });
             console.log(\`✅ Notificación enviada a \${numeroLimpiado}\`);
          } else {
             console.log(\`[SIMULACIÓN] Mensaje que se habría enviado a \${numeroLimpiado}: \${mensaje}\`);
          }
        } catch (err) {
          console.error(\`❌ Error al enviar aviso a \${numeroLimpiado}:\`, err.message);
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
          if (!encargado.nombre) {
            console.log(\`[WHATSAPP] Saltando encargado sin nombre\`);
            continue;
          }
          
          let num = null;
          
          // 1. Intentar usar el teléfono dinámico (si el frontend lo envió)
          if (encargado.telefono) {
            num = encargado.telefono.replace(/[^0-9]/g, '');
          } 
          // 2. Fallback: mapeo estático para tarjetas viejas
          else {
            const nom = encargado.nombre.toLowerCase();
            if (nom.includes("griger")) num = "584248037379";
            else if (nom.includes("idalys")) num = "584122966969";
          }
          
          if (num && num.length >= 10) {
            try {
              if (clientSocket && waState === 'CONNECTED') {
                await clientSocket.sendMessage(\`\${num}@s.whatsapp.net\`, { text: \`⚠️ *Actualización de Proyecto*\\n\${pushMsg}\` });
                console.log(\`[WHATSAPP] Notificación enviada a encargado \${encargado.nombre} (\${num})\`);
                await sleep(60000); // 60s delay
              }
            } catch (err) {
              console.error(\`❌ Error al enviar aviso WA a encargado \${encargado.nombre}:\`, err.message);
            }
          } else {
            console.log(\`[WHATSAPP] No se encontró un número mapeado para el encargado: \${encargado.nombre}\`);
          }
        }
      } else {
        console.log(\`[WHATSAPP] El proyecto no tiene encargados asignados para enviar WS.\`);
      }
    }
  })
  .subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      console.log('Backend suscrito a cambios de estado en Supabase');
    }
  });
`;

code = code.replace('let clientSocket = null;', listener + '\n\nlet clientSocket = null;');
fs.writeFileSync('index.js', code);
