FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY packages/contracts ./packages/contracts
COPY services/chat-service ./services/chat-service

WORKDIR /app/services/chat-service
EXPOSE 3008
USER node
CMD ["node", "dist/index.js"]
