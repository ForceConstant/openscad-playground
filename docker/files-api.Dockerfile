# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Server files API — the sidecar that gives the playground a shared, server-
# side folder of models. It is a zero-dependency Node service, so the image is
# tiny and needs no build stage.
# ---------------------------------------------------------------------------
FROM node:22-alpine

WORKDIR /app

COPY server/files-api/server.cjs ./server.cjs

# The directory models are read from / written to. Mount a host folder or a
# named volume here (see docker-compose.yml).
RUN mkdir -p /data/models && chown -R node:node /data /app

ENV NODE_ENV=production \
    FILES_DIR=/data/models \
    PORT=8080

LABEL org.opencontainers.image.title="OpenSCAD Playground Files API" \
      org.opencontainers.image.description="Server-side model storage for the OpenSCAD Playground" \
      org.opencontainers.image.source="https://github.com/openscad/openscad-playground" \
      org.opencontainers.image.licenses="NOASSERTION"

EXPOSE 8080

# Drop privileges. NOTE: when /data/models is a *bind mount* the host folder
# must be writable by uid/gid 1000 (node). A named volume inherits the
# ownership set above. See the README for details.
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null 2>&1 || exit 1

CMD ["node", "server.cjs"]
