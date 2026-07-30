FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY packages/contracts ./packages/contracts
COPY services/api-gateway ./services/api-gateway

WORKDIR /app/services/api-gateway
EXPOSE 5001
USER node
CMD ["node", "dist/index.js"]
