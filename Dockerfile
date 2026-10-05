# Clinic API — Express + Mongoose (multi-tenant). Production image.
# Build:  docker build -t clinic-api ./clynicApi
# Run:    docker run --env-file clynicApi/.env -p 5000:5000 clinic-api
FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=production
# Container clock. The app mixes two date models: analytics/dashboard bucket with an explicit
# 'Asia/Kolkata' timezone, while lib/datetime.js (slot generation, queue-token day keys, day-close,
# check-in, recalls) uses SERVER-LOCAL time. An Alpine image defaults to UTC, which puts those two
# 5h30m apart — wrong booking slots, tokens resetting at 05:30 IST, and a cash register that
# disagrees with analytics. Pinning IST makes them consistent.
# NOTE: this is a stopgap for the current single-region (India) deployment. Serving clinics in
# another timezone requires a per-clinic `Clinic.timezone` and one tz-aware date helper.
ENV TZ=Asia/Kolkata
RUN apk add --no-cache tzdata && cp /usr/share/zoneinfo/Asia/Kolkata /etc/localtime && echo "Asia/Kolkata" > /etc/timezone

# Install dependencies first (better layer caching). package-lock.json is copied when present.
# Driver SDKs live in optionalDependencies; --no-optional can be passed at build time to skip them.
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# App source.
COPY src ./src
COPY assets ./assets
COPY scripts ./scripts

# Writable dirs for the non-root user: private file storage (LOCAL_STORAGE_DIR) and the Baileys
# WhatsApp session (BAILEYS_SESSION_DIR). /app is root-owned, so the app can't create them itself.
RUN mkdir -p storage baileys_auth && chown node:node storage baileys_auth

# Run as the built-in non-root user.
USER node

EXPOSE 5000
# Basic liveness: the app exposes GET /api/health (src/routes/index.js).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/health',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/index.js"]
