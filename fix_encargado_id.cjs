const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf-8');

// replace: if (enc.user_id) { ... [enc.user_id] }
code = code.replace(/if \(enc\.user_id\) \{\n\s*await enviarPushNotificacion\("Nuevo Proyecto Asignado", `Fuiste asignado al proyecto: \$\{newRecord\.titulo\}`, \[enc\.user_id\]\);\n\s*\}/g, 
  `if (enc.user_id || enc.id) {
          await enviarPushNotificacion("Nuevo Proyecto Asignado", \`Fuiste asignado al proyecto: \${newRecord.titulo}\`, [enc.user_id || enc.id]);
        }`);

fs.writeFileSync('index.js', code);
