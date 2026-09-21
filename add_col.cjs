require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function run() {
  const { data: cols } = await supabase.from('columnas').select('*').order('orden', { ascending: true });
  
  if (cols && cols.length > 0) {
    const exists = cols.find(c => c.nombre === 'En Diseño');
    if (!exists) {
      // Find order of 'Levantamiento'
      const levIdx = cols.findIndex(c => c.nombre === 'Levantamiento');
      let targetOrder = 1; // Default if not found
      if (levIdx !== -1) {
          targetOrder = cols[levIdx].orden + 1;
          // Shift others
          for(let i = levIdx + 1; i < cols.length; i++) {
              await supabase.from('columnas').update({ orden: cols[i].orden + 1 }).eq('id', cols[i].id);
          }
      }
      await supabase.from('columnas').insert([{ nombre: 'En Diseño', orden: targetOrder }]);
      console.log('Columna En Diseño insertada correctamente.');
    } else {
      console.log('La columna ya existe.');
    }
  } else {
      console.log('No hay columnas personalizadas, usará defaultEstados.');
  }
}
run();
