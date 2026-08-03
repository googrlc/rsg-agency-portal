# RSG Agency Portal — zero-dependency Node static host + backend proxy.
FROM node:20-alpine

WORKDIR /app

# No runtime dependencies; copy the app as-is.
COPY package.json ./
COPY server.js ./
COPY routing.js ./
COPY services.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Lightweight liveness check against the built-in /healthz route.
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
