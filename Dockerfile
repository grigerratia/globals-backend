FROM ghcr.io/puppeteer/puppeteer:latest

# Cambiamos a usuario root para instalar dependencias
USER root

WORKDIR /app

# Copiamos package.json
COPY package*.json ./
# Usamos npm para instalar ya que viene con la imagen
RUN npm install

# Copiamos el resto del código
COPY . .

# Darle permisos al usuario pptruser sobre /app para que pueda crear .wwebjs_auth
RUN chown -R pptruser:pptruser /app

# Volvemos al usuario pptruser para mayor seguridad
USER pptruser

EXPOSE 3000

CMD ["node", "index.js"]
