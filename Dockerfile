FROM node:22-slim

# dumb-init ile sinyal yönetimi
RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Önce dependency dosyalarını kopyala (layer cache)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Uygulama kodunu kopyala
COPY index.js ./

# dumb-init ile başlat (zombie process'leri temizler, sinyal yönetimi)
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
