const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf8');

code = code.replace(/Asegúrate de pedir un número de WhatsApp/, `Asegúrate de pedir un número de WhatsApp (no exijas que pongan el código de país +58 ni 58, asume que es de Venezuela y guarda el número tal cual lo den)`);

fs.writeFileSync('index.js', code);
