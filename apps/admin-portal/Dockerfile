FROM mirror.gcr.io/library/node:24-alpine AS builder
WORKDIR /app
ARG NEXT_PUBLIC_APP_NAME="wApi Super Admin"
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_GOOGLE_AUTH_ENABLED=true
ENV NEXT_PUBLIC_APP_NAME=$NEXT_PUBLIC_APP_NAME
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_GOOGLE_AUTH_ENABLED=$NEXT_PUBLIC_GOOGLE_AUTH_ENABLED
COPY packages/contracts/package*.json ./packages/contracts/
RUN cd packages/contracts && npm install
COPY packages/contracts ./packages/contracts
RUN cd packages/contracts && npm run build

COPY apps/admin-portal/package*.json apps/admin-portal/connectsphere-contracts-0.1.0.tgz ./apps/admin-portal/
RUN cd apps/admin-portal && npm install
COPY apps/admin-portal ./apps/admin-portal
RUN cd apps/admin-portal && npm run build

FROM mirror.gcr.io/library/node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ARG NEXT_PUBLIC_APP_NAME="wApi Super Admin"
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_GOOGLE_AUTH_ENABLED=true
ENV NEXT_PUBLIC_APP_NAME=$NEXT_PUBLIC_APP_NAME
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_GOOGLE_AUTH_ENABLED=$NEXT_PUBLIC_GOOGLE_AUTH_ENABLED
COPY --from=builder /app/packages/contracts ./packages/contracts
COPY --from=builder /app/apps/admin-portal ./apps/admin-portal
WORKDIR /app/apps/admin-portal
RUN npm prune --omit=dev && rm -rf /usr/local/lib/node_modules/npm
EXPOSE 3100
USER node
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3100"]
