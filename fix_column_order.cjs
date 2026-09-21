require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function run() {
  const { data: cols } = await supabase.from('columnas').select('*').order('orden', { ascending: true });
  
  for (let i = 0; i < cols.length; i++) {
    await supabase.from('columnas').update({ orden: i }).eq('id', cols[i].id);
    console.log(`Updated ${cols[i].nombre} to orden ${i}`);
  }
}
run();
