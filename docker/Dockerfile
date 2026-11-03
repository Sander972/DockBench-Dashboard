# Static output is arch-independent: build natively, only the runtime stage is arm64. The runtime stage has no RUN step, so CI needs no QEMU.
FROM --platform=$BUILDPLATFORM oven/bun:1 AS bun
# vue-tsc needs real Node: oven/bun's `node` is bun, which can't load vue-tsc's TypeScript patch, so .vue imports fail to resolve.
FROM --platform=$BUILDPLATFORM node:22-slim AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1-slim
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server ./server
ENV DATA_DIR=/data STATIC_DIR=/app/dist PORT=3001
EXPOSE 3001
CMD ["bun", "server/index.ts"]
