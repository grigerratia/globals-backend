const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf8');

// Update prompt to avoid duplicates
code = code.replace(/Caso 2: Si el usuario solo está agradeciendo[^}]*?}/, `Caso 2: Si el usuario solo está agradeciendo, diciendo 'ok', 'vale', o despidiéndose (después de que ya registraste su pedido o durante la charla), o si YA creaste el proyecto en mensajes anteriores, NO pidas más datos ni envíes proyecto_listo de nuevo, solo despídete amablemente:
{
  "tipo": "conversacion",
  "respuesta": "¡De nada! Quedamos a tu entera disposición. Un miembro de nuestro equipo te escribirá pronto."
}`);

// Don't delete memory, keep it
code = code.replace('chatMemory.delete(chatId);', `history.push(\`Asistente: ¡Perfecto! Hemos registrado tu solicitud sobre "\${iaResponse.titulo}".\\nUn miembro de nuestro equipo te contactará muy pronto para continuar.\`);
        if (history.length > 15) history.splice(0, history.length - 10);`);

fs.writeFileSync('index.js', code);
