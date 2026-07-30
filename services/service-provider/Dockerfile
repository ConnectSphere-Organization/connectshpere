FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY packages/contracts ./packages/contracts
COPY services/service-provider ./services/service-provider

WORKDIR /app/services/service-provider
EXPOSE 3004
USER node
CMD ["node", "dist/main.js"]
