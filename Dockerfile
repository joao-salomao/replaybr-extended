FROM oven/bun:1.3-slim

# O host não precisa de ffmpeg: ele vive dentro da imagem.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

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
