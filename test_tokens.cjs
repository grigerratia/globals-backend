const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function run() {
  const { data, error } = await supabase.from('fcm_tokens').select('*');
  console.log("Tokens:", data?.length || 0);
  if (error) console.error(error);
}
run();
