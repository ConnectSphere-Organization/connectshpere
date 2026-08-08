FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY packages/contracts ./packages/contracts
COPY services/automation-service ./services/automation-service
RUN cd packages/contracts && npm install && npm run build
RUN cd services/automation-service && npm install && npm run build

WORKDIR /app/services/automation-service
EXPOSE 3001
USER node
CMD ["node", "dist/index.js"]
