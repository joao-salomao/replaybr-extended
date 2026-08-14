FROM oven/bun:1.3-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY public ./public
COPY server.ts index.ts tsconfig.json ./

ENV PORT=3000
ENV WORK_DIR=/app/work
EXPOSE 3000

CMD ["bun", "run", "server.ts"]
