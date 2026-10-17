FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=5178

COPY package.json server.js ./
COPY public ./public
RUN mkdir -p /app/data

EXPOSE 5178

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:5178/api/health >/dev/null || exit 1

CMD ["node", "server.js"]
