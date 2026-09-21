require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function run() {
  const { data } = await supabase.rpc('get_empleados');
  console.log("get_empleados IDs:", data.map(d => d.id));
  
  const { data: users } = await supabase.from('fcm_tokens').select('user_id');
  console.log("fcm_tokens user_ids:", users.map(u => u.user_id));
}
run();
