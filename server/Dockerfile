# API image. Build from the repository root so workspace manifests are available:
#   docker build -f server/Dockerfile -t trip-war-room-api .
FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=4000

WORKDIR /app

# Install production dependencies from the workspace lockfile.
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --omit=dev --no-audit --no-fund

COPY server ./server

WORKDIR /app/server

# The embedded MongoDB fallback is development-only; production requires MONGODB_URI.
EXPOSE 4000
CMD ["node", "src/index.js"]
