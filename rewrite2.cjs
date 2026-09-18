const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf-8');

code = code.replace(/const\s+__dirname\s*=\s*path\.dirname\(fileURLToPath\(import\.meta\.url\)\);\nconst\s+chromeLibs[\s\S]*?(?=\/\/ --- Firebase)/, '');

fs.writeFileSync('index.js', code);
