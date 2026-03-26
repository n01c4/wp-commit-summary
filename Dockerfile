FROM node:22-slim

# Puppeteer (headless Chrome) için gerekli sistem paketleri
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    dumb-init \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Puppeteer'ın sistem Chromium'unu kullanması için
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

# Önce dependency dosyalarını kopyala (layer cache)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Uygulama kodunu kopyala
COPY index.js ./

# WhatsApp oturum verisi için volume mount noktası
VOLUME /app/.wwebjs_auth

# dumb-init ile başlat (zombie process'leri temizler, sinyal yönetimi)
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
