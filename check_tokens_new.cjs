require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function run() {
  const { data } = await supabase.from('fcm_tokens').select('*');
  console.log("Tokens in DB:");
  console.log(data);
}
run();
