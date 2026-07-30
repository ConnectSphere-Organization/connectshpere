FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY packages/contracts ./packages/contracts
COPY services/campaign-service ./services/campaign-service

WORKDIR /app/services/campaign-service
EXPOSE 3002
USER node
CMD ["node", "dist/index.js"]
