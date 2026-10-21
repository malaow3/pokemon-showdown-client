# Build stage (the client build script requires Node.js >= 22.18)
FROM node:22-bookworm-slim AS builder

# Commit that produced this image; passed in by CI (--build-arg GIT_SHA=...)
ARG GIT_SHA=unknown
ARG POKEBIN_HOST=pokebin.com

WORKDIR /app

# Copy dependency manifests
COPY package.json package-lock.json deno.lock* ./

# Install Node deps needed by the build script
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Copy source files
COPY . .

# build-tools/update shells out to `php build-tools/news-embed.php` to embed the
# news, and this image has no PHP. Provide a shim that scrapes the production
# client page instead (see docker/php-news-shim.js).
RUN install -m 0755 docker/php-news-shim.js /usr/local/bin/php

# Build the Pokemon Showdown client. The normal incremental build skips
# graphics.js when it is absent, so force the battle animation bundle afterward.
# `update full` exits with code 2 when generated data files (data/pokedex.js etc.)
# can't be cachebusted. They're intentionally absent from this image and are served
# from upstream by nginx (see /data/ in nginx.conf), so tolerate exit code 2 only.
RUN POKEBIN_HOST="$POKEBIN_HOST" npm run build \
    && rm -f play.pokemonshowdown.com/data/graphics.js play.pokemonshowdown.com/data/graphics.js.map \
    && { node build-tools/update full || [ "$?" -eq 2 ]; } \
    && sed -i 's/\[failed to retrieve news\]//g' play.pokemonshowdown.com/caches/index-*.html
# ^ news is embedded at build time (php shim -> play.pokemonshowdown.com, then
#   pokemonshowdown.com/news.json). If every source is down, show nothing instead
#   of "[failed to retrieve news]"; the page fills it in from /news.json (cached
#   by nginx) when it can.

# Stamp the built commit so the running deployment can be identified at runtime
# (served uncached at /version.txt — see nginx.conf).
RUN echo "$GIT_SHA" > play.pokemonshowdown.com/version.txt

# API/proxy stage
FROM denoland/deno:2.3.3 AS deno-server

WORKDIR /app

# Copy built assets and server
COPY --from=builder /app/play.pokemonshowdown.com ./play.pokemonshowdown.com
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/deno.lock* ./

# Cache deno dependencies
RUN --mount=type=cache,target=/root/.cache/deno \
    deno cache server.ts

# Expose the port
EXPOSE 4000

ENV PORT=4000

# Run the server
CMD ["deno", "run", "--allow-net", "--allow-read", "--allow-env", "server.ts"]

# Static nginx stage
FROM nginx:1.27-alpine AS nginx

COPY --from=builder /app/play.pokemonshowdown.com /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
