# Build stage
FROM denoland/deno:2.3.3 AS builder

WORKDIR /app

# Copy dependency manifests
COPY package.json deno.lock* ./

# Install Node deps needed by the build script
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm \
    && rm -rf /var/lib/apt/lists/* \
    && npm install

# Copy source files
COPY . .

# Build the Pokemon Showdown client
RUN npm run build

# Production stage
FROM denoland/deno:2.3.3

WORKDIR /app

# Copy built assets and server
COPY --from=builder /app/play.pokemonshowdown.com ./play.pokemonshowdown.com
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/deno.lock* ./

# Cache deno dependencies
RUN deno cache server.ts

# Expose the port
EXPOSE 4000

ENV PORT=4000

# Run the server
CMD ["deno", "run", "--allow-net", "--allow-read", "--allow-env", "server.ts"]
