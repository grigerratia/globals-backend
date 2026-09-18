import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function check() {
  const { data, error } = await supabase.from('users').select('*').limit(1);
  if (error) {
     console.error(error);
  } else {
     console.log(data);
  }
}
check();
