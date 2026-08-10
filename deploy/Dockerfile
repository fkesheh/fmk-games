# syntax=docker/dockerfile:1

# ---- build: full workspace install (devDeps included), then vite (fps + bank +
# kart + wordbomb + rift + splat clients) + esbuild (platform server bundle; every
# @<game>/server and the shared packages are inlined).
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
COPY games/wordbomb/shared/package.json games/wordbomb/shared/package.json
COPY games/wordbomb/server/package.json games/wordbomb/server/package.json
COPY games/wordbomb/client/package.json games/wordbomb/client/package.json
COPY games/rift/shared/package.json games/rift/shared/package.json
COPY games/rift/server/package.json games/rift/server/package.json
COPY games/rift/client/package.json games/rift/client/package.json
COPY games/splat/shared/package.json games/splat/shared/package.json
COPY games/splat/server/package.json games/splat/server/package.json
COPY games/splat/client/package.json games/splat/client/package.json
# npm install (not ci): the committed lock skews across platforms (macOS vs linux
# optional deps) and npm versions — let the image resolve on-platform.
RUN npm install
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
COPY games/wordbomb/shared/package.json games/wordbomb/shared/package.json
COPY games/wordbomb/server/package.json games/wordbomb/server/package.json
COPY games/wordbomb/client/package.json games/wordbomb/client/package.json
COPY games/rift/shared/package.json games/rift/shared/package.json
COPY games/rift/server/package.json games/rift/server/package.json
COPY games/rift/client/package.json games/rift/client/package.json
COPY games/splat/shared/package.json games/splat/shared/package.json
COPY games/splat/server/package.json games/splat/server/package.json
COPY games/splat/client/package.json games/splat/client/package.json
RUN npm install --omit=dev

# ---- runtime. Each game module resolves its clientDist as
# ../../../games/<id>/client/dist relative to platform/server/dist (bundled
# layout), so the repo-root layout must be preserved under /app for EVERY game.
# WORDBOMB additionally reads its dictionary blob from
# games/wordbomb/server/data at startup — that COPY is load-bearing: without it
# the image builds clean and ENOENTs on the first room.
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/platform/server/dist ./platform/server/dist
COPY --from=build /app/games/fps/client/dist ./games/fps/client/dist
COPY --from=build /app/games/bank/client/dist ./games/bank/client/dist
COPY --from=build /app/games/kart/client/dist ./games/kart/client/dist
COPY --from=build /app/games/wordbomb/client/dist ./games/wordbomb/client/dist
COPY --from=build /app/games/wordbomb/server/data ./games/wordbomb/server/data
COPY --from=build /app/games/rift/client/dist ./games/rift/client/dist
COPY --from=build /app/games/splat/client/dist ./games/splat/client/dist
USER node
EXPOSE 8080
CMD ["node", "platform/server/dist/server.js"]
