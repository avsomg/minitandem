# syntax=docker/dockerfile:1
# Two release images of one commit share the build stage: the API (target app, the default) and Caddy with its own copy of the
# public files and its configuration (target edge). Compose builds both with the same tag, so files and API never come from different commits.
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
# The deployed commit goes into build-info.json, so the files of a release are told apart even when the catalogue revision is unchanged.
ARG RELEASE_COMMIT=local
RUN node build.mjs --public && node -e 'const fs=require("node:fs"),p=".publish/build-info.json",info=JSON.parse(fs.readFileSync(p));info.commit=process.argv[1];fs.writeFileSync(p,JSON.stringify(info,null,2)+"\n")' "$RELEASE_COMMIT"

# A fixed Caddy release, so a rebuild never picks up a new one unseen. 2.11.7 was checked on the server on 17 October 2026
# (sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f). Raise it on purpose, after caddy validate.
# The configuration and the log script are in the image, not mounted from the checkout: a container then always has the files of its own release.
FROM caddy:2.11.7-alpine AS edge
COPY --from=build /app/.publish /srv/site
COPY docker/Caddyfile docker/site.caddy docker/preview.Caddyfile docker/access-log-entrypoint.sh /etc/caddy/

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
