const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf-8');

const listener = `
const recentUpdates = new Set();

supabase
  .channel('backend-estado-updates')
  .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'proyectos' }, async (payload) => {
    const oldRecord = payload.old;
    const newRecord = payload.new;

    if (oldRecord.estado !== newRecord.estado && newRecord.estado !== 'Archivado') {
      
      const dedupeKey = \`\${newRecord.id}-\${newRecord.estado}\`;
      if (recentUpdates.has(dedupeKey)) {
        return;
      }
      recentUpdates.add(dedupeKey);
      setTimeout(() => recentUpdates.delete(dedupeKey), 5000);

      console.log(\`[🔄 CAMBIO DE ESTADO] Proyecto "\${newRecord.titulo}" -> "\${newRecord.estado}"\`);
      
      // Notificar cliente
      if (newRecord.cliente_telefono) {
        const numeroLimpiado = newRecord.cliente_telefono.replace(/[^0-9]/g, '');
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
      }

      // Enviar notificaciones PUSH y WA a los encargados
      if (newRecord.encargados && newRecord.encargados.length > 0) {
        const userIds = newRecord.encargados.filter(e => e.user_id).map(e => e.user_id);
        const pushMsg = "El proyecto " + newRecord.titulo + " avanzó a: " + newRecord.estado;
        
        if (userIds.length > 0) {
          await enviarPushNotificacion("Actualización de Proyecto", pushMsg, userIds);
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
                await clientSocket.sendMessage(\`\${num}@s.whatsapp.net\`, { text: \`⚠️ *Actualización de Proyecto*\\n\${pushMsg}\` });
                console.log(\`[WHATSAPP] Notificación enviada a encargado \${encargado.nombre} (\${num})\`);
                await sleep(60000); 
              }
            } catch (err) {
              console.error(\`❌ Error al enviar aviso WA a encargado \${encargado.nombre}:\`, err.message);
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
`;

code = code.replace('let clientSocket = null;', listener + '\n\nlet clientSocket = null;');
fs.writeFileSync('index.js', code);
