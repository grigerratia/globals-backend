with open('index.js', 'r') as f:
    content = f.read()

old_logic = """    if (!necesitaAlerta && pry.fecha_ultima_actualizacion) {"""

new_logic = """    if (pry.notas) {
      const match = pry.notas.match(/\\[DÍAS ESTIMADOS FASE ACTUAL: (\\d+)\\]/);
      if (match) {
        const diasTotales = parseInt(match[1], 10);
        const fechaUltima = new Date(pry.fecha_ultima_actualizacion || pry.fecha_creacion);
        fechaUltima.setHours(0,0,0,0);
        const deadlineFase = new Date(fechaUltima);
        deadlineFase.setDate(deadlineFase.getDate() + diasTotales);
        
        const diffFase = Math.round((deadlineFase - hoyNorm) / (1000 * 60 * 60 * 24));
        if (diffFase === 1) {
           msj += (msj ? '\\n\\n' : '') + `⚠️ *ALERTA DE FASE*\\nMañana se vence el tiempo estimado para la fase "${pry.estado}" del proyecto "${pry.titulo}".`;
           necesitaAlerta = true;
        } else if (diffFase === 0) {
           msj += (msj ? '\\n\\n' : '') + `🚨 *FASE VENCIDA HOY*\\nHoy vence el tiempo estimado para la fase "${pry.estado}" del proyecto "${pry.titulo}".`;
           necesitaAlerta = true;
        } else if (diffFase < 0) {
           msj += (msj ? '\\n\\n' : '') + `💥 *FASE RETRASADA*\\nEl proyecto "${pry.titulo}" ha superado el tiempo estimado para la fase "${pry.estado}".`;
           necesitaAlerta = true;
        }
      }
    }

    if (!necesitaAlerta && pry.fecha_ultima_actualizacion) {"""
content = content.replace(old_logic, new_logic)

with open('index.js', 'w') as f:
    f.write(content)
