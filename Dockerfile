FROM node:20-alpine

WORKDIR /app

# Dependências primeiro (layer cache)
COPY package*.json ./
RUN npm ci --omit=dev

# Código-fonte
COPY src/ ./src/
COPY scripts/ ./scripts/

# Diretórios de dados e logs
RUN mkdir -p data logs

# Usuário não-root por segurança
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/server.js"]
