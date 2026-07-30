FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY packages/contracts ./packages/contracts
COPY services/contact-service ./services/contact-service

WORKDIR /app/services/contact-service
EXPOSE 3007
USER node
CMD ["node", "dist/index.js"]
