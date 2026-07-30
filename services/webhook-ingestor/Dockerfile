FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY packages/contracts ./packages/contracts
COPY services/webhook-ingestor ./services/webhook-ingestor

WORKDIR /app/services/webhook-ingestor
EXPOSE 3013
USER node
CMD ["node", "dist/index.js"]
