require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const fs = require('fs');

const serviceAccount = JSON.parse(fs.readFileSync('./firebase-service-account.json', 'utf8'));
initializeApp({ credential: cert(serviceAccount) });
const messaging = getMessaging();

async function run() {
  const { data } = await supabase.from('fcm_tokens').select('token');
  if (!data || data.length === 0) return console.log("No tokens found");
  
  const tokens = [...new Set(data.map(d => d.token))];
  console.log("Tokens to send:", tokens.length);
  
  const message = {
    notification: {
      title: "Test Notification",
      body: "This is a test to see if push works",
    },
    tokens: tokens,
  };

  try {
    const response = await messaging.sendEachForMulticast(message);
    console.log("Success:", response.successCount);
    console.log("Failures:", response.failureCount);
    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        console.error("Token", idx, "failed:", resp.error);
      }
    });
  } catch (e) {
    console.error("Fatal error:", e);
  }
}
run();
