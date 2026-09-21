const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf-8');

const target = `  const message = {
    data: {
      title: titulo,
      body: body,
      click_action: "/"
    },
    tokens: tokens,
  };`;

const replacement = `  const message = {
    notification: {
      title: titulo,
      body: body,
    },
    tokens: tokens,
  };`;

if (code.includes(target)) {
  code = code.replace(target, replacement);
  fs.writeFileSync('index.js', code);
  console.log("Restored original payload");
}
