const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf-8');

const target = `        if (userIds.length > 0) {
          await enviarPushNotificacion("Actualización de Proyecto", pushMsg, userIds);
        }`;

const replacement = `        if (userIds.length > 0) {
          // Add a 5 second delay so the user has time to background the app
          setTimeout(async () => {
            await enviarPushNotificacion("Actualización de Proyecto", pushMsg, userIds);
          }, 5000);
        }`;

if (code.includes(target)) {
  code = code.replace(target, replacement);
  fs.writeFileSync('index.js', code);
  console.log("Added 5s delay to push");
}
