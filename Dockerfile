FROM ghcr.io/puppeteer/puppeteer:latest

# Cambiamos a usuario root para instalar dependencias si hace falta
USER root

WORKDIR /app

# Copiamos package.json y pnpm-lock si existe
COPY package*.json ./
# Usamos npm para instalar ya que viene con la imagen
RUN npm install

# Copiamos el resto del código
COPY . .

# Volvemos al usuario pptruser para mayor seguridad
USER pptruser

EXPOSE 3000

CMD ["node", "index.js"]
