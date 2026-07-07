# Clinic API — Express + Mongoose (multi-tenant). Production image.
# Build:  docker build -t clinic-api ./clynicApi
# Run:    docker run --env-file clynicApi/.env -p 5000:5000 clinic-api
FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# Install dependencies first (better layer caching). package-lock.json is copied when present.
# Driver SDKs live in optionalDependencies; --no-optional can be passed at build time to skip them.
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# App source.
COPY src ./src
COPY assets ./assets
COPY scripts ./scripts

# Run as the built-in non-root user.
USER node

EXPOSE 5000
# Basic liveness: the app exposes GET /api/health (src/routes/index.js).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/health',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/index.js"]
