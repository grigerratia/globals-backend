const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf-8');

code = code.replace(/import\s+qrcode\s+from\s+['"]qrcode-terminal['"];\s*import\s+pkg\s+from\s+['"]whatsapp-web\.js['"];\s*const\s+\{\s*Client,\s*LocalAuth\s*\}\s*=\s*pkg;/, 
`import { default as makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';`);

code = code.replace(/const\s+resolveChromePath[\s\S]*?(?=\n\n\/\/ --- Firebase)/, '');

code = code.replace(/const\s+client\s*=\s*new\s+Client\(\{[\s\S]*?client\.initialize\(\);/m, 
`let clientSocket = null;

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
  
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' })
  });
  
  clientSocket = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      console.log('[WHATSAPP] QR Event recibido.');
      waState = 'QR_READY';
      try {
        latestQrDataUrl = await qrcodeData.toDataURL(qr);
      } catch(e) {
        console.error('Error al generar QR data URL:', e);
      }
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('[WHATSAPP] Conexión cerrada. ¿Reconectar?', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 2000);
      } else {
        waState = 'DISCONNECTED';
      }
    } else if (connection === 'open') {
      console.log('[WHATSAPP] Client is ready!');
      waState = 'CONNECTED';
      latestQrDataUrl = null;
    }
  });
}

connectToWhatsApp();`);

code = code.replace(/await\s+client\.sendMessage\(([^,]+),\s*([^)]+)\);/g, `await clientSocket.sendMessage($1.replace('@c.us', '@s.whatsapp.net'), { text: $2 });`);

fs.writeFileSync('index.js', code);
