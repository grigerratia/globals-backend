const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf-8');

const insertBlock = `          const { error: insertErr } = await supabase.from('proyectos').insert([{
            titulo: classification.titulo,
            cliente_nombre: classification.nombre_cliente,
            cliente_empresa: classification.empresa,
            cliente_telefono: classification.cliente_telefono,
            notas: classification.notas,
            estado: classification.estado || 'En Conversación',
            fecha_entrega: null
          }]);`;

const newInsertBlock = `          // Buscar Líder Comercial por defecto
          const { data: liderData } = await supabase.from('usuarios').select('id, nombre, rol').eq('rol', 'Líder Comercial').limit(1);
          let encargados_default = [];
          if (liderData && liderData.length > 0) {
            encargados_default = [{ id: liderData[0].id, nombre: liderData[0].nombre, rol: 'Líder Comercial' }];
          }

          const { error: insertErr } = await supabase.from('proyectos').insert([{
            titulo: classification.titulo,
            cliente_nombre: classification.nombre_cliente,
            cliente_empresa: classification.empresa,
            cliente_telefono: classification.cliente_telefono,
            notas: classification.notas,
            estado: classification.estado || 'En Conversación',
            fecha_entrega: null,
            encargados: encargados_default
          }]);`;

if(code.includes(insertBlock)) {
    code = code.replace(insertBlock, newInsertBlock);
    fs.writeFileSync('index.js', code);
    console.log("Updated index.js");
} else {
    console.log("Could not find insert block in index.js");
}
