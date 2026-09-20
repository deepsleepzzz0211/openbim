# syntax=docker/dockerfile:1
# Multi-stage build for OpenBIM Hub (build context = repository root):
#   docker build -f docker/Dockerfile --target api --tag openbim-hub-api .
#   docker build -f docker/Dockerfile --target web --tag openbim-hub-web .

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @openbim-hub/api exec prisma generate
RUN pnpm -r build

# ---- API runtime ------------------------------------------------------------
FROM node:22-alpine AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
WORKDIR /app/apps/api
EXPOSE 3001
CMD ["sh", "-c", "pnpm exec prisma db push --skip-generate && node dist/server.js"]

# ---- Web runtime (nginx + API reverse proxy) --------------------------------
FROM node:22-alpine AS webbuild
WORKDIR /app
RUN corepack enable
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=build /app/apps/web ./apps/web
COPY --from=build /app/packages ./packages
WORKDIR /app/apps/web
RUN pnpm exec vite build

FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=webbuild /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
