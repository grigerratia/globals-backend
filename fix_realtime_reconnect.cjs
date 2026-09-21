const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf-8');

const target1 = `.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      console.log('Backend suscrito a cambios de estado en Supabase');
    }
  });`;

const replacement1 = `.subscribe((status, err) => {
    if (status === 'SUBSCRIBED') {
      console.log('Backend suscrito a cambios de estado en Supabase');
    } else {
      console.error('Realtime estado status:', status, err);
      if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
         setTimeout(() => process.exit(1), 5000); // Fuerza a Render a reiniciar la app para recuperar el WebSocket
      }
    }
  });`;

const target2 = `.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      console.log('Backend suscrito a comentarios');
    }
  });`;
  
const replacement2 = `.subscribe((status, err) => {
    if (status === 'SUBSCRIBED') {
      console.log('Backend suscrito a comentarios');
    } else {
      console.error('Realtime comentarios status:', status, err);
      if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
         setTimeout(() => process.exit(1), 5000);
      }
    }
  });`;

code = code.replace(target1, replacement1).replace(target2, replacement2);
fs.writeFileSync('index.js', code);
console.log("Fixed reconnect logic");
