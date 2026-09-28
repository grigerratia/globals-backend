with open('index.js', 'r') as f:
    content = f.read()

import re

old_insert = """          const { error: insertErr } = await supabase.from('proyectos').insert([{
            titulo: classification.titulo,
            cliente_nombre: classification.nombre_cliente,
            cliente_empresa: classification.empresa,
            cliente_telefono: classification.cliente_telefono,
            notas: classification.notas,
            estado: classification.estado || 'En Conversación',
            fecha_entrega: null,
            encargados: encargados_default
          }]);"""

new_insert = """          const notasFinales = (classification.notas || '') + '\\n\\n[DÍAS ESTIMADOS FASE ACTUAL: 3]';
          const { error: insertErr } = await supabase.from('proyectos').insert([{
            titulo: classification.titulo,
            cliente_nombre: classification.nombre_cliente,
            cliente_empresa: classification.empresa,
            cliente_telefono: classification.cliente_telefono,
            notas: notasFinales.trim(),
            estado: classification.estado || 'En Conversación',
            fecha_entrega: null,
            encargados: encargados_default
          }]);"""

content = content.replace(old_insert, new_insert)

with open('index.js', 'w') as f:
    f.write(content)
