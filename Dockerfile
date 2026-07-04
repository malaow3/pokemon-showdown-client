# Build stage
FROM denoland/deno:2.3.3 AS builder

# Commit that produced this image; passed in by CI (--build-arg GIT_SHA=...)
ARG GIT_SHA=unknown

WORKDIR /app

# Copy dependency manifests
COPY package.json package-lock.json deno.lock* ./

# Install Node deps needed by the build script
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends nodejs npm \
    && rm -rf /var/lib/apt/lists/*
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Copy source files
COPY . .

# Build the Pokemon Showdown client
RUN npm run build

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
