FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install -g pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /app/var && chown node:node /app/var
USER node
ENV PORT=8090 BIND_HOST=0.0.0.0
EXPOSE 8090
CMD ["node","server/team-http.mjs"]
