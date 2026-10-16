# PromptForge — Podman/Docker container
# Node 22 + Python 3 for the randomizer script. Debian-based because
# onnxruntime-node requires glibc (won't work on alpine).

FROM node:22-slim

WORKDIR /app

# Python for scripts/randomizer.py, openssl for self-signed TLS cert generation
RUN apt-get update && apt-get install -y --no-install-recommends python3 curl openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Ensure data and logs directories exist and are writable by the host user
RUN mkdir -p /app/data /app/logs && chmod -R 775 /app/data /app/logs

EXPOSE 8090

# Listen on every interface inside the container. The app's own default is
# 127.0.0.1, which in a container is reachable from nowhere: a plain
# `docker run -p 8090:8090` served nothing until this (found 3 Oct 2026).
# compose.yaml sets the same; this covers running the image without it.
ENV PROMPTFORGE_BIND=0.0.0.0

# Fetches the third-party H3 documents the image does not carry, then starts
# the server. See scripts/docker-start.sh.
CMD ["sh", "scripts/docker-start.sh"]
