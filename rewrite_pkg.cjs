const fs = require('fs');
let pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));

delete pkg.dependencies['whatsapp-web.js'];
delete pkg.dependencies['qrcode-terminal'];
delete pkg.dependencies['puppeteer'];
delete pkg.dependencies['puppeteer-core'];

pkg.dependencies['@whiskeysockets/baileys'] = '^6.7.9';
pkg.dependencies['pino'] = '^9.4.0';

fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
