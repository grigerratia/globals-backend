require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
async function run() {
  const { data } = await supabase.from('proyectos').select('cliente_nombre, cliente_empresa, cliente_telefono').limit(5);
  console.log(data);
}
run();
