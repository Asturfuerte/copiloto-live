FROM node:22-alpine
RUN apk add --no-cache poppler-utils unzip tesseract-ocr tesseract-ocr-data-spa
WORKDIR /app
COPY package.json server.js documentos.js index.html ./
COPY conocimiento ./conocimiento
COPY documentos ./documentos
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
