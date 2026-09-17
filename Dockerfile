FROM node:20-alpine

WORKDIR /app

# Copiamos package.json
COPY package*.json ./
RUN npm install --production

# Copiamos el resto del código
COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
