FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN groupadd --gid 10001 nexus \
    && useradd --uid 10001 --gid nexus --shell /usr/sbin/nologin --create-home nexus \
    && mkdir -p /app/data \
    && chown -R 10001:10001 /app

COPY --from=dependencies --chown=10001:10001 /app/node_modules ./node_modules
COPY --chown=10001:10001 package.json package-lock.json ./
COPY --chown=10001:10001 src ./src

USER 10001:10001

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 CMD ["node", "src/healthcheck.js"]
STOPSIGNAL SIGTERM
CMD ["node", "src/bot.js"]
