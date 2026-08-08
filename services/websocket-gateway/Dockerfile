FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY packages/contracts ./packages/contracts
COPY services/websocket-gateway ./services/websocket-gateway
RUN cd services/websocket-gateway && npm install && npm run build

WORKDIR /app/services/websocket-gateway
EXPOSE 3009
USER node
CMD ["node", "dist/index.js"]
