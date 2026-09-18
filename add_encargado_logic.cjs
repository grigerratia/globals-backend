const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf-8');

const encargadoLogic = `
    // Detectar si se agregó un encargado nuevo
    const oldEnc = oldRecord.encargados || [];
    const newEnc = newRecord.encargados || [];
    
    // Buscar encargados que están en newEnc pero no en oldEnc (comparando id o user_id)
    const agregados = newEnc.filter(n => !oldEnc.some(o => (o.user_id && o.user_id === n.user_id) || (o.id && o.id === n.id) || (o.nombre === n.nombre)));
    
    if (agregados.length > 0) {
      console.log(\`[👥 NUEVO ENCARGADO] En proyecto "\${newRecord.titulo}"\`);
      for (const enc of agregados) {
        if (enc.user_id) {
          await enviarPushNotificacion("Nuevo Proyecto Asignado", \`Fuiste asignado al proyecto: \${newRecord.titulo}\`, [enc.user_id]);
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
                await clientSocket.sendMessage(\`\${num}@s.whatsapp.net\`, { text: \`📌 *Nuevo Proyecto Asignado*\\nHas sido asignado al proyecto: *\${newRecord.titulo}*.\` });
                console.log(\`[WHATSAPP] Aviso de asignación a \${enc.nombre} (\${num})\`);
                await sleep(5000);
             }
           } catch(e) {
             console.error(\`Error avisando asignación a \${enc.nombre}:\`, e.message);
           }
        }
      }
    }
`;

code = code.replace(
  "if (oldRecord.estado !== newRecord.estado && newRecord.estado !== 'Archivado') {",
  encargadoLogic + "\n    if (oldRecord.estado !== newRecord.estado && newRecord.estado !== 'Archivado') {"
);

fs.writeFileSync('index.js', code);
