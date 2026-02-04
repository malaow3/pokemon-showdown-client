# Build stage
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy package files
COPY package.json bun.lockb* ./

# Install dependencies (including Elysia)
RUN bun install

# Copy source files
COPY . .

# Build the Pokemon Showdown client
RUN bun run build

# Production stage
FROM oven/bun:1-slim

WORKDIR /app

# Copy built assets and server
COPY --from=builder /app/play.pokemonshowdown.com ./play.pokemonshowdown.com
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Expose the port
EXPOSE 4000

ENV PORT=4000

# Run the server
CMD ["bun", "run", "server.ts"]
