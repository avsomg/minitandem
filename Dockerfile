# syntax=docker/dockerfile:1
# The public site plus the small service (server.mjs) in one image. Caddy in front of it is a separate container (compose.yaml).
# Build from a clean clone of the repository, never from a working folder that holds private editorial state:
# .dockerignore lists only what the build needs and names every private path again at the end.
ARG NODE_VERSION=24.22.0

FROM node:${NODE_VERSION}-alpine AS dependencies
WORKDIR /app/editorial
COPY editorial/package.json editorial/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:${NODE_VERSION}-alpine AS build
ARG MINITANDEM_FAMILY_SYNC=0
ENV MINITANDEM_FAMILY_SYNC=${MINITANDEM_FAMILY_SYNC}
WORKDIR /app
COPY . .
COPY --from=dependencies /app/editorial/node_modules editorial/node_modules
# --public builds from the tracked files alone. The publication gates need private evidence that is not in the repository,
# so they do not run here; the build prints that. They run on the owner's machine before a change is committed.
RUN node build.mjs --public

FROM node:${NODE_VERSION}-alpine
ENV NODE_ENV=production \
    MINITANDEM_HOST=0.0.0.0 \
    MINITANDEM_PORT=8787 \
    MINITANDEM_STATE_DIR=/state \
    MINITANDEM_CORRECTION_DIR=/state/corrections
WORKDIR /app
COPY --from=build /app /app
# The state directory is a named volume in compose.yaml. It belongs to the unprivileged user, so a fresh volume is writable.
RUN mkdir -p /state/corrections && chown -R node:node /state && chmod +x docker/entrypoint.sh
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.MINITANDEM_PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["docker/entrypoint.sh"]
