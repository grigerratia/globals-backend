import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function run() {
  const query = `
    CREATE TABLE IF NOT EXISTS whatsapp_auth (
      id text PRIMARY KEY,
      data jsonb NOT NULL
    );
  `;
  const { data, error } = await supabase.rpc('exec_sql', { query });
  
  if (error) {
    console.log("RPC exec_sql failed. Using REST to create table is not supported natively. Please use SQL Editor.");
    console.log(error);
  } else {
    console.log("Table created.");
  }
}
run();
