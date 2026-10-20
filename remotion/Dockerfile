# Worker render video Visual Office (Remotion). Basis Debian 12: compositor Remotion butuh glibc ≥ 2.35,
# sedangkan Rocky 8 hanya glibc 2.28 — jadi worker berjalan di kontainer (Podman/Docker).
FROM docker.io/library/node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 libxkbcommon-dev libxfixes3 \
      libxcomposite1 libxdamage1 libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2 \
      fonts-noto-color-emoji fonts-noto-core ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
# musik latar & Chrome headless untuk Remotion disiapkan saat build
RUN node scripts/make-music.mjs \
 && node --input-type=module -e "import { ensureBrowser } from '@remotion/renderer'; await ensureBrowser();"
ENV NODE_ENV=production
CMD ["node", "worker.mjs"]
