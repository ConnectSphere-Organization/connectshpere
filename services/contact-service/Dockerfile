FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY packages/contracts ./packages/contracts
COPY services/contact-service ./services/contact-service
RUN cd packages/contracts && npm install && npm run build
RUN cd services/contact-service && npm install && npm run build

WORKDIR /app/services/contact-service
EXPOSE 3007
USER node
CMD ["node", "dist/index.js"]
