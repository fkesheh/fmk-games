# syntax=docker/dockerfile:1

# ---- build: full workspace install (devDeps included), then vite (fps client) +
# esbuild (platform server bundle; @fps/server + both shared packages are inlined).
FROM node:22-alpine AS build
WORKDIR /app
# Root devDep puppeteer must not download a browser into the build image.
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json ./
COPY platform/shared/package.json platform/shared/package.json
COPY platform/server/package.json platform/server/package.json
COPY games/fps/shared/package.json games/fps/shared/package.json
COPY games/fps/server/package.json games/fps/server/package.json
COPY games/fps/client/package.json games/fps/client/package.json
RUN npm ci
COPY . .
RUN npm run build

# ---- prod deps: the server bundle imports only node builtins + ws (esbuild inlines
# @fps/server, @fps/shared and @platform/shared), so no game/shared src is shipped.
# npm ci --omit=dev also installs the client workspace's prod dep (three); the
# runtime never loads it and the image stays < 250MB.
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY platform/shared/package.json platform/shared/package.json
COPY platform/server/package.json platform/server/package.json
COPY games/fps/shared/package.json games/fps/shared/package.json
COPY games/fps/server/package.json games/fps/server/package.json
COPY games/fps/client/package.json games/fps/client/package.json
RUN npm ci --omit=dev

# ---- runtime. The fps module resolves its clientDist as ../../../games/fps/client/dist
# relative to platform/server/dist (bundled layout), so the repo-root layout must be
# preserved under /app.
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/platform/server/dist ./platform/server/dist
COPY --from=build /app/games/fps/client/dist ./games/fps/client/dist
USER node
EXPOSE 8080
CMD ["node", "platform/server/dist/server.js"]
