# Statically linked ffmpeg, copied in rather than installed.
#
# `apt-get install ffmpeg` pulls in codecs, X11 and graphics libraries this app
# never touches: 411 MB of the 607 MB image. This one binary is ~99 MB and
# depends on nothing, which is also why it works on Alpine's musl. ffprobe
# isn't needed: width/height/duration are read directly with src/mp4.ts.
FROM mwader/static-ffmpeg:7.1 AS ffmpeg

FROM oven/bun:1.3-alpine

# The host doesn't need ffmpeg: it lives inside the image.
COPY --from=ffmpeg /ffmpeg /usr/local/bin/

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
