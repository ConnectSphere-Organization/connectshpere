FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY packages/contracts ./packages/contracts
COPY services/auth-service ./services/auth-service
RUN cd packages/contracts && npm install && npm run build
RUN cd services/auth-service && npm install && npm run build

WORKDIR /app/services/auth-service
EXPOSE 3006
USER node
CMD ["node", "dist/index.js"]
