# ---- Build stage ----
FROM node:20-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# ---- Runtime stage ----
FROM node:20-slim

# Playwright Chromium system dependencies (Debian bookworm)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
    libx11-xcb1 fonts-noto-cjk fonts-noto-color-emoji \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/apps ./apps

# Install Playwright Chromium browser binary (only chromium, skip firefox/webkit)
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright-browsers
RUN npx playwright install chromium

# Runtime config
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/src/index.js"]
