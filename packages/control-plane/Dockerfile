# --- build the monorepo ---
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Copy the full workspace (node_modules/dist are excluded via .dockerignore),
# then install so the @vibe/* workspace links resolve exactly as they do locally.
COPY . .
RUN npm install
RUN npm run build --workspace @vibe/shared && npm run build --workspace @vibe/control-plane

# --- runtime ---
FROM node:22-bookworm-slim AS runtime
WORKDIR /app/packages/control-plane
# Docker CLI so the control plane can build/run app containers via the mounted socket.
COPY --from=docker:24-cli /usr/local/bin/docker /usr/local/bin/docker
ENV NODE_ENV=production
# Use the legacy builder so we don't need the buildx plugin in this image.
ENV DOCKER_BUILDKIT=0
COPY --from=build /app /app
EXPOSE 8080
CMD ["node", "dist/index.js"]
