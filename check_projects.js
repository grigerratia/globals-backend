import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function check() {
  const { data, error } = await supabase.from('proyectos').select('id, titulo, encargados').limit(5);
  console.log(JSON.stringify(data, null, 2));
}
check();
