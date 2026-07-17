# syntax=docker/dockerfile:1

# ---- build: full workspace install (devDeps included), then vite (client) + esbuild (server).
FROM node:22-alpine AS build
WORKDIR /app
# Root devDep puppeteer must not download a browser into the build image.
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci
COPY . .
RUN npm run build

# ---- prod deps: the server bundle imports only node builtins + ws (esbuild inlines
# @fps/shared), so shared/src is NOT shipped. npm ci --omit=dev also installs the client
# workspace's prod dep (three); the runtime never loads it and the image stays < 250MB.
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci --omit=dev

# ---- runtime. server.js resolves the client as ../../client/dist relative to
# server/dist, so the repo-root layout must be preserved under /app.
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist
USER node
EXPOSE 8080
CMD ["node", "server/dist/server.js"]
