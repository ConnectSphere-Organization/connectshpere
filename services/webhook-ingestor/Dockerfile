FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY packages/contracts ./packages/contracts
COPY services/webhook-ingestor ./services/webhook-ingestor
RUN cd packages/contracts && npm install && npm run build
RUN cd services/webhook-ingestor && npm install && npm run build

WORKDIR /app/services/webhook-ingestor
EXPOSE 3013
USER node
CMD ["node", "dist/index.js"]
