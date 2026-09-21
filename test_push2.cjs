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
  if (!data || data.length === 0) return console.log("No tokens");
  
  const tokens = [...new Set(data.map(d => d.token))];
  
  const message = {
    notification: {
      title: "Test Notification",
      body: "Testing new payload structure",
    },
    data: {
      title: "Test Notification",
      body: "Testing new payload structure",
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
  };

  try {
    const response = await messaging.sendEachForMulticast(message);
    console.log("Success:", response.successCount);
  } catch (e) {
    console.error("Fatal error:", e);
  }
}
run();
