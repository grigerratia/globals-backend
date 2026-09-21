require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function run() {
  // Can't easily check Realtime settings from JS client, but we can try to subscribe locally!
  console.log("Subscribing locally...");
  supabase
    .channel('test-realtime')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'proyectos' }, (payload) => {
      console.log("RECEIVED UPDATE:", payload.new.titulo);
    })
    .subscribe((status) => {
      console.log("Subscription status:", status);
    });

  setTimeout(async () => {
    console.log("Triggering update...");
    const { data } = await supabase.from('proyectos').select('id').limit(1);
    if (data && data.length > 0) {
      await supabase.from('proyectos').update({ notas: "test " + Date.now() }).eq('id', data[0].id);
    }
  }, 3000);

  setTimeout(() => {
    console.log("Done");
    process.exit(0);
  }, 8000);
}
run();
