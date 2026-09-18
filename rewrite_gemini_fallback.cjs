const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf-8');

// Remove the global model initialization
code = code.replace(/const model = genAI\.getGenerativeModel\(\{[\s\S]*?\}\);\n/, "");

// Replace the bot listener logic with a fallback mechanism
const botLogicRegex = /const chatSession = model\.startChat\(\{[\s\S]*?const classification = parseClassification\(result\.response\.text\(\)\);/m;

const newBotLogic = `
        const modelosATestar = [
          'gemini-3.8-flash',
          'gemini-3.5-flash-lite',
          'gemini-3.1-flash-lite',
          'gemini-flash-latest',
          'gemini-flash-lite-latest'
        ];
        
        let classification = null;
        let success = false;
        
        for (const modelName of modelosATestar) {
          try {
            console.log(\`[BOT] Intentando responder con el modelo: \${modelName}\`);
            const model = genAI.getGenerativeModel({
              model: modelName,
              systemInstruction: SYSTEM_PROMPT,
              generationConfig: {
                responseMimeType: 'application/json',
              },
            });
            
            const chatSession = model.startChat({ history: [] });
            const result = await chatSession.sendMessage(textMessage);
            classification = parseClassification(result.response.text());
            success = true;
            break; // Salimos del for loop si tuvo éxito
          } catch (modelErr) {
            console.error(\`[BOT] Falló el modelo \${modelName}: \${modelErr.message}\`);
          }
        }
        
        if (!success || !classification) {
           throw new Error("Todos los modelos de Gemini fallaron o están saturados.");
        }
`;

code = code.replace(botLogicRegex, newBotLogic);
fs.writeFileSync('index.js', code);
