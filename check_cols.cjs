require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function run() {
  const { data: cols } = await supabase.from('columnas').select('*').order('orden', { ascending: true });
  console.log("Columnas actuales en DB:");
  console.log(cols.map(c => `${c.orden}: ${c.nombre}`));
}
run();
