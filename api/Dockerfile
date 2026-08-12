
# ---- Build stage -------------------------------------------------------

FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm install --omit=dev

COPY src ./src



# ---- Runtime stage -------------------------------------------------------

FROM node:20-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app



# Non-root user (alpine already ships a 'node' user/group, uid/gid 1000)

COPY --from=build --chown=node:node /app/node_modules ./node_modules

COPY --from=build --chown=node:node /app/src ./src

COPY --chown=node:node package.json ./



USER node

EXPOSE 8080



HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \

  CMD node -e "require('http').get('http://127.0.0.1:8080/healthz', r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))"



CMD ["node", "src/index.js"]

