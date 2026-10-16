# syntax=docker/dockerfile:1
# Two release images share the build stage: the API and Caddy with its own immutable public files.
# Build from a clean clone of the repository, never from a working folder that holds private editorial state:
# .dockerignore lists only what the build needs and names every private path again at the end.
ARG NODE_VERSION=24.12.0

FROM node:${NODE_VERSION}-alpine AS dependencies
WORKDIR /app/editorial
COPY editorial/package.json editorial/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
COPY . .
COPY --from=dependencies /app/editorial/node_modules editorial/node_modules
# --public builds from the tracked files alone. The publication gates need private evidence that is not in the repository,
# so they do not run here; the build prints that. They run on the owner's machine before a change is committed.
ARG RELEASE_COMMIT=local
RUN node build.mjs --public && node -e 'const fs=require("node:fs"),p=".publish/build-info.json",info=JSON.parse(fs.readFileSync(p));info.commit=process.argv[1];fs.writeFileSync(p,JSON.stringify(info,null,2)+"\n")' "$RELEASE_COMMIT"

FROM caddy:2-alpine AS edge
COPY --from=build /app/.publish /srv/site
COPY docker/Caddyfile docker/site.caddy docker/preview.Caddyfile /etc/caddy/

FROM node:${NODE_VERSION}-alpine AS app
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
