FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV MCP_PORT=8080
ENV MCP_DATA_DIR=/srv/mcp-reasoning/data
RUN mkdir -p /srv/mcp-reasoning/data
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY src/storage/migrations ./src/storage/migrations
EXPOSE 8080
CMD ["node", "dist/index.js"]
