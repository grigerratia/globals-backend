const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf-8');

const target = `  try {
    const response = await messaging.sendEachForMulticast(message);
    console.log("Push enviado exitosamente:", response.successCount, "exitos,", response.failureCount, "fallos.");
  } catch (error) {`;

if (!code.includes('Push enviado exitosamente:')) {
  // It's not in the code. Let's find the try block.
  const oldTry = `  try {
    const response = await messaging.sendEachForMulticast(message);
  } catch (error) {`;
  const newTry = `  try {
    const response = await messaging.sendEachForMulticast(message);
    console.log("[PUSH] Enviado exitosamente. Exitos:", response.successCount, "Fallos:", response.failureCount);
  } catch (error) {`;
  
  if (code.includes(oldTry)) {
    code = code.replace(oldTry, newTry);
    fs.writeFileSync('index.js', code);
    console.log("Added logging");
  }
}
