FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY packages/contracts ./packages/contracts
COPY services/billing-service ./services/billing-service
RUN cd packages/contracts && npm install && npm run build
RUN cd services/billing-service && npm install && npm run build

WORKDIR /app/services/billing-service
EXPOSE 3003
USER node
CMD ["node", "dist/index.js"]
