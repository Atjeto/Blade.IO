FROM node:20-alpine

WORKDIR /app

# install deps first for cache
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# copy app
COPY server ./server
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server/index.js"]
