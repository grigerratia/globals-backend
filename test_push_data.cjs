require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const fs = require('fs');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let serviceAccount = JSON.parse(fs.readFileSync('./firebase-service-account.json', 'utf-8'));
initializeApp({ credential: cert(serviceAccount) });
const messaging = getMessaging();

async function run() {
  const { data } = await supabase.from('fcm_tokens').select('*');
  const tokens = data.map(d => d.token);
  
  const message = {
    data: {
      title: "Prueba Directa DATA",
      body: "Si ves esto, el payload DATA funciona.",
      click_action: "/"
    },
    tokens: tokens,
  };
  
  const response = await messaging.sendEachForMulticast(message);
  console.log("Firebase response DATA:", response);
}
run();
