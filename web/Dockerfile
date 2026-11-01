# Web client image. Build from the repository root:
#   docker build -f web/Dockerfile -t trip-war-room-web .
FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --no-audit --no-fund

COPY web ./web
RUN npm --workspace web run build

FROM nginx:1.27-alpine

COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html

EXPOSE 80
