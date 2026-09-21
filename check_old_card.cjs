require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function run() {
  const { data } = await supabase.from('proyectos').select('id, encargados').limit(5);
  console.log(JSON.stringify(data, null, 2));
}
run();
