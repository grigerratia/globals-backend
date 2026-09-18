const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf-8');

const comentarioListener = `
  .channel('comentarios-updates')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'comentarios' }, async (payload) => {
    const newComment = payload.new;
    console.log(\`[💬 NUEVO COMENTARIO] Proyecto ID: \${newComment.proyecto_id}, Por: \${newComment.autor_nombre}\`);
    
    // Buscar encargados del proyecto
    const { data: proyecto, error } = await supabase
      .from('proyectos')
      .select('titulo, encargados')
      .eq('id', newComment.proyecto_id)
      .single();
      
    if (!error && proyecto && proyecto.encargados && proyecto.encargados.length > 0) {
      // Filtrar a los encargados que no sean el autor del comentario (si es que tenemos su id)
      // Asumiendo que el autor_id no está disponible directamente o si, mandamos a todos por ahora
      const userIds = proyecto.encargados.filter(e => e.user_id && e.nombre !== newComment.autor_nombre).map(e => e.user_id);
      
      if (userIds.length > 0) {
        const pushMsg = \`\${newComment.autor_nombre} comentó en \${proyecto.titulo}: "\${newComment.texto.substring(0, 50)}..."\`;
        await enviarPushNotificacion("Nuevo Comentario", pushMsg, userIds);
      }
    }
  })
  .subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      console.log('Backend suscrito a nuevos comentarios');
    }
  });

`;

code = code.replace(
  /console\.log\('Backend suscrito a cambios de estado en Supabase'\);\n    \}\n  \}\);\n/g,
  "console.log('Backend suscrito a cambios de estado en Supabase');\n    }\n  });\n\nsupabase" + comentarioListener + "\n"
);
fs.writeFileSync('index.js', code);
