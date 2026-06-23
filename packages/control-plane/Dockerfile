# --- build the monorepo ---
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Bun builds the portal SPA (its dev/build runner); grab just the binary.
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun
# Copy the full workspace (node_modules/dist are excluded via .dockerignore),
# then install so the @vibe/* workspace links resolve exactly as they do locally.
COPY . .
RUN npm install
RUN npm run build --workspace @vibe/shared && npm run build --workspace @vibe/control-plane
# Build the React/Vite owner portal → packages/portal/dist (served by the
# control plane behind the owner session).
RUN bun run --cwd packages/portal build

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
