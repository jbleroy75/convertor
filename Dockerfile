FROM node:22-bookworm-slim

ARG PANDOC_VERSION=3.6.4
ARG TARGETARCH

# Moteurs de conversion. Pandoc officiel (celui de Debian casse --sandbox pour docx/odt/epub).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg imagemagick libheif1 poppler-utils librsvg2-bin \
      libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-draw \
      fonts-dejavu fonts-liberation fonts-noto-core fonts-noto-color-emoji \
      ca-certificates curl tini \
 && arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
 && curl -fsSL "https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}/pandoc-${PANDOC_VERSION}-linux-${arch}.tar.gz" \
    | tar xz --strip-components=2 -C /usr/local/bin "pandoc-${PANDOC_VERSION}/bin/pandoc" \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# Politique ImageMagick durcie (aucun accès réseau, pas de MVG/MSL/PS, limites de ressources).
COPY deploy/imagemagick-policy.xml /etc/ImageMagick-6/policy.xml

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public

RUN mkdir -p /data /tmp/convertor && chown node:node /data /tmp/convertor
USER node

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    TMP_DIR=/tmp/convertor \
    PANDOC_BIN=/usr/local/bin/pandoc

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]
