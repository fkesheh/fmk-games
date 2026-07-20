# syntax=docker/dockerfile:1

# ---- build: full workspace install (devDeps included), then vite (fps + bank
# clients) + esbuild (platform server bundle; @fps/server, @bank/server and the
# shared packages are inlined).
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
COPY games/bank/shared/package.json games/bank/shared/package.json
COPY games/bank/server/package.json games/bank/server/package.json
COPY games/bank/client/package.json games/bank/client/package.json
COPY games/kart/shared/package.json games/kart/shared/package.json
COPY games/kart/server/package.json games/kart/server/package.json
COPY games/kart/client/package.json games/kart/client/package.json
RUN npm ci
COPY . .
RUN npm run build && npm run build -w @bank/client && npm run build -w @kart/client

# ---- prod deps: the server bundle imports only node builtins + ws (esbuild inlines
# the game server + shared packages), so no game/shared src is shipped.
# npm ci --omit=dev also installs the client workspaces' prod deps (three); the
# runtime never loads them and the image stays < 250MB.
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY platform/shared/package.json platform/shared/package.json
COPY platform/server/package.json platform/server/package.json
COPY games/fps/shared/package.json games/fps/shared/package.json
COPY games/fps/server/package.json games/fps/server/package.json
COPY games/fps/client/package.json games/fps/client/package.json
COPY games/bank/shared/package.json games/bank/shared/package.json
COPY games/bank/server/package.json games/bank/server/package.json
COPY games/bank/client/package.json games/bank/client/package.json
COPY games/kart/shared/package.json games/kart/shared/package.json
COPY games/kart/server/package.json games/kart/server/package.json
COPY games/kart/client/package.json games/kart/client/package.json
RUN npm ci --omit=dev

# ---- runtime. Each game module resolves its clientDist as
# ../../../games/<id>/client/dist relative to platform/server/dist (bundled
# layout), so the repo-root layout must be preserved under /app for BOTH games.
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/platform/server/dist ./platform/server/dist
COPY --from=build /app/games/fps/client/dist ./games/fps/client/dist
COPY --from=build /app/games/bank/client/dist ./games/bank/client/dist
COPY --from=build /app/games/kart/client/dist ./games/kart/client/dist
USER node
EXPOSE 8080
CMD ["node", "platform/server/dist/server.js"]
