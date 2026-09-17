FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache git

# Copiamos package.json
COPY package*.json ./
RUN npm install

# Copiamos el resto del código
COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
