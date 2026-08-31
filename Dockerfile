FROM node:26.8.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY build.mjs ./
COPY src/ src/
COPY codecs/ codecs/
COPY models/ models/
RUN npm run build && npm prune --omit=dev

FROM node:26.8.1-bookworm-slim
ENV NODE_ENV=production PI_APP_HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/dist/ dist/
COPY src/ src/
COPY codecs/ codecs/
COPY models/ models/
COPY public/ public/
COPY licenses/ licenses/
COPY server.mjs package.json NOTICE.md ./
USER node
EXPOSE 8788
CMD ["node", "server.mjs"]
