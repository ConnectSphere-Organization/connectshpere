FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY packages/contracts ./packages/contracts
COPY services/chat-service ./services/chat-service
RUN cd packages/contracts && npm install && npm run build
RUN cd services/chat-service && npm install && npm run build

WORKDIR /app/services/chat-service
EXPOSE 3008
USER node
CMD ["node", "dist/index.js"]
