const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf-8');

const targetBlock = `    if (!necesitaAlerta && pry.fecha_ultima_actualizacion) {

      const fechaUltima = new Date(pry.fecha_ultima_actualizacion);
      fechaUltima.setHours(0,0,0,0);
      const diasEstancado = Math.floor((hoyNorm - fechaUltima) / (1000 * 60 * 60 * 24));
      if (diasEstancado >= 2) {
        msj = \`⏳ *PROYECTO ESTANCADO*\\nEl proyecto "\${pry.titulo}" lleva \${diasEstancado} días sin avanzar.\\nFase actual: \${pry.estado}\`;
        necesitaAlerta = true;
      }
    }`;

const newBlock = `    if (!necesitaAlerta && pry.fecha_ultima_actualizacion) {
      const fechaUltima = new Date(pry.fecha_ultima_actualizacion);
      fechaUltima.setHours(0,0,0,0);
      const diasEstancado = Math.floor((hoyNorm - fechaUltima) / (1000 * 60 * 60 * 24));
      
      if (diasEstancado >= 2) {
        necesitaAlerta = true;
        try {
          const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
          const prompt = \`Actúas como un asistente de gestión de proyectos muy natural y humano. 
          Tienes que redactar un mensaje corto (máximo 30-40 palabras) de notificación push para avisarle al equipo que un proyecto está estancado.
          
          Datos del proyecto:
          - Título: "\${pry.titulo}"
          - Días estancado: \${diasEstancado}
          - Fase actual: "\${pry.estado}"
          
          INSTRUCCIONES:
          - No seas robótico. Usa un tono alerta pero colaborativo y directo.
          - Inicia con un emoji (ej. ⏳ o 🚨).
          - Menciona claramente lo que deben hacer para avanzar, dependiendo de la fase actual. Por ejemplo, si está en 'Levantamiento', diles que deben cotizar y enviar presupuesto. Si está en 'En Diseño', diles que revisen y aprueben el arte.
          - NO uses formato markdown complejo, solo texto plano y amigable.\`;
          
          const aiResponse = await model.generateContent(prompt);
          msj = "Alerta\\nProyecto estancado\\n" + aiResponse.response.text().trim();
        } catch (e) {
          console.error('Error usando Gemini para CRON:', e);
          msj = \`⏳ *PROYECTO ESTANCADO*\\nEl proyecto "\${pry.titulo}" lleva \${diasEstancado} días sin avanzar.\\nFase actual: \${pry.estado}\`;
        }
      }
    }`;

if (code.includes(targetBlock)) {
  code = code.replace(targetBlock, newBlock);
  fs.writeFileSync('index.js', code);
  console.log("CRON logic updated with AI!");
} else {
  console.log("Could not find CRON target block.");
}
