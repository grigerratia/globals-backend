const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf8');

// 1. Add 'cors' and 'qrcode' imports
code = code.replace(/import express from 'express';/, `import express from 'express';\nimport cors from 'cors';\nimport qrcodeData from 'qrcode';`);

// 2. Add express middleware
code = code.replace(/const app = express\(\);/, `const app = express();\napp.use(cors());\napp.use(express.json());\n\nlet waState = 'DISCONNECTED';\nlet latestQrDataUrl = null;\n`);

// 3. Add API endpoints
code = code.replace(/app\.get\('\/health', \(_req, res\) => {/, `app.get('/api/whatsapp/status', (_req, res) => {\n  res.json({\n    status: waState,\n    qr: latestQrDataUrl\n  });\n});\n\napp.get('/health', (_req, res) => {`);

// 4. Update the WhatsApp client events
code = code.replace(/client\.on\('qr', \(qr\) => {/, `client.on('qr', async (qr) => {\n  console.log('[WHATSAPP] QR Event recibido.');\n  waState = 'QR_READY';\n  try {\n    latestQrDataUrl = await qrcodeData.toDataURL(qr);\n  } catch(e) {\n    console.error('Error al generar QR data URL:', e);\n  }\n`);

code = code.replace(/client\.on\('ready', \(\) => {/, `client.on('ready', () => {\n  waState = 'CONNECTED';\n  latestQrDataUrl = null;\n`);

code = code.replace(/client\.on\('authenticated', \(\) => {/, `client.on('authenticated', () => {\n  waState = 'AUTHENTICATED';\n  latestQrDataUrl = null;\n`);

code = code.replace(/client\.on\('disconnected', \(reason\) => {/, `client.on('disconnected', (reason) => {\n  waState = 'DISCONNECTED';\n  latestQrDataUrl = null;\n`);

fs.writeFileSync('index.js', code);
