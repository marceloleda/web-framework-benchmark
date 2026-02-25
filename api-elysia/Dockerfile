FROM oven/bun:1-alpine AS base
WORKDIR /app
COPY package*.json bun.lockb* ./
RUN bun install --frozen-lockfile --production || bun install --production
COPY . .
EXPOSE 3003
CMD ["bun", "run", "src/index.ts"]
