FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
# scripts/ and eval/ ship too so migrations, the sheet import, and the accuracy
# eval can be run inside the container (docker compose exec backend npm run ...).
COPY src ./src
COPY scripts ./scripts
COPY eval ./eval
EXPOSE 3001
CMD ["node", "src/index.js"]
