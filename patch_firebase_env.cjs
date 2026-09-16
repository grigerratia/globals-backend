const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf8');

code = code.replace(/import serviceAccount from "\.\/firebase-service-account\.json" with { type: "json" };/, `let serviceAccount = {};
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else if (fs.existsSync('./firebase-service-account.json')) {
    serviceAccount = JSON.parse(fs.readFileSync('./firebase-service-account.json', 'utf8'));
  }
} catch (e) {
  console.error("Error cargando firebase-service-account", e);
}
`);

fs.writeFileSync('index.js', code);
