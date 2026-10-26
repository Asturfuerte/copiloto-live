FROM node:22-alpine
RUN apk add --no-cache poppler-utils unzip tesseract-ocr tesseract-ocr-data-spa
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js documentos.js passkeys.js recordatorios.js push.js pedidos.js index.html ./
COPY conocimiento ./conocimiento
COPY documentos ./documentos
COPY public ./public
ENV PORT=3000 OMP_THREAD_LIMIT=1
EXPOSE 3000
CMD ["node", "server.js"]
