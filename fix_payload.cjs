const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf-8');

const target = `  const message = {
    notification: {
      title: titulo,
      body: body,
    },
    data: {
      title: titulo,
      body: body,
      click_action: "/"
    },
    webpush: {
      notification: {
        icon: "/vite.svg"
      },
      fcmOptions: {
        link: "/"
      }
    },
    tokens: tokens,
  };`;

const replacement = `  const message = {
    data: {
      title: titulo,
      body: body,
      click_action: "/"
    },
    tokens: tokens,
  };`;

if (code.includes(target)) {
  code = code.replace(target, replacement);
  fs.writeFileSync('index.js', code);
  console.log("Fixed payload to DATA ONLY");
} else {
  console.log("Target not found");
}
