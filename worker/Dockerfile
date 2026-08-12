
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



RUN apk add --no-cache procps



COPY --from=build --chown=node:node /app/node_modules ./node_modules

COPY --from=build --chown=node:node /app/src ./src

COPY --chown=node:node package.json ./



USER node



CMD ["node", "src/index.js"]

