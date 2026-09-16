const fs = require("fs");
let js = fs.readFileSync("index.js", "utf8");

// I will just rewrite the cron manually by matching the block
js = js.replace(/cron\.schedule\('0 8 \* \* \*', async \(\) => \{[\s\S]*?\}\);/, `cron.schedule('0 8 * * *', async () => {
  console.log('[CRON] Verificando proyectos atrasados...');
  
  const { data: proyectos, error } = await supabase
    .from('proyectos')
    .select('*')
    .not('estado', 'in', '("Entregado y cerrado", "Archivado")');

  if (error || !proyectos) {
    console.error('Error al consultar proyectos para CRON:', error);
    return;
  }

  const hoy = new Date();
  const alertas = [];

  for (const pry of proyectos) {
    let necesitaAlerta = false;
    let msj = '';

    if (pry.fecha_entrega) {
      const fechaEntrega = new Date(pry.fecha_entrega);
      if (fechaEntrega < hoy) {
        msj = \`⚠️ *ALERTA DE RETRASO*\\nEl proyecto "\${pry.titulo}" debió entregarse el \${fechaEntrega.toLocaleDateString()}.\\nFase actual: \${pry.estado}\`;
        necesitaAlerta = true;
      }
    }
    
    if (!necesitaAlerta && pry.fecha_ultima_actualizacion) {
      const fechaUltima = new Date(pry.fecha_ultima_actualizacion);
      const diasEstancado = Math.floor((hoy - fechaUltima) / (1000 * 60 * 60 * 24));
      if (diasEstancado >= 3) {
        msj = \`⏳ *PROYECTO ESTANCADO*\\nEl proyecto "\${pry.titulo}" lleva \${diasEstancado} días sin avanzar.\\nFase actual: \${pry.estado}\`;
        necesitaAlerta = true;
      }
    }

    if (necesitaAlerta) {
      alertas.push({
        proyecto: pry.titulo,
        mensaje: msj,
        encargados: pry.encargados || []
      });
    }
  }

  if (alertas.length === 0) {
    console.log('[CRON] Ningún proyecto atrasado el día de hoy.');
    return;
  }

  console.log(\`[CRON] Se encontraron \${alertas.length} proyectos atrasados. Procesando notificaciones...\`);
  
  for (const alerta of alertas) {
    const pushUserIds = alerta.encargados.filter(e => e.user_id).map(e => e.user_id);
    if (pushUserIds.length > 0) {
      await enviarPushNotificacion("⚠️ Alerta de Proyecto", alerta.mensaje, pushUserIds);
    }
  }
});`);

fs.writeFileSync("index.js", js);
