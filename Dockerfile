# Public demo image (Cloud Run or any container host). One instance only: calls live in memory.
FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY data ./data
COPY kb ./kb
# The container must listen on all interfaces; the local default stays 127.0.0.1.
ENV HOST=0.0.0.0 PORT=8080 TRUST_PROXY=1 DATA_DIR=/tmp/data NODE_ENV=production
USER node
CMD ["node", "src/server.mjs"]
