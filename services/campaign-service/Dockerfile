FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY packages/contracts ./packages/contracts
COPY services/campaign-service ./services/campaign-service
RUN cd packages/contracts && npm install && npm run build
RUN cd services/campaign-service && npm install && npm run build

WORKDIR /app/services/campaign-service
EXPOSE 3002
USER node
CMD ["node", "dist/index.js"]
