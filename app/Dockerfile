FROM node:20-alpine
LABEL maintainer="getouch"
WORKDIR /app

# poppler-utils for PDF page rendering (pdftoppm)
RUN apk add --no-cache poppler-utils

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "server.js"]
