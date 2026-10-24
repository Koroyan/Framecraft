# API + worker image (same image, different command).
# Build from the repository root:  docker build -f apps/server/Dockerfile -t framecraft-server .
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@12.8.1 --activate
WORKDIR /repo

FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --filter @framecraft/server...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN pnpm --filter @framecraft/server build \
 && pnpm deploy --filter @framecraft/server --prod /out

FROM node:24-bookworm-slim AS runtime
# Modern FFmpeg (xfade transitions, libass subtitles) and fonts with Georgian/Cyrillic coverage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-noto-core ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000 \
    FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe \
    FFMPEG_FONT_FILE=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
WORKDIR /app
COPY --from=build /out ./
COPY --from=build /repo/apps/server/dist ./dist
COPY --from=build /repo/apps/server/drizzle ./drizzle
USER node
EXPOSE 4000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
