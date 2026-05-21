# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data

RUN apk add --no-cache curl git jq tree

WORKDIR /app

# Install production deps (tsx is a production dep so npm run embed works)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist
COPY get-data.sh build-embeddings.ts ./

# Create /data owned by the node user before dropping privileges
RUN mkdir -p /data && chown node:node /data

# Drop to non-root user
USER node

# Volume for runtime data (populated externally via get-data.sh + npm run embed)
VOLUME ["/data"]

CMD ["node", "dist/src/index.js"]
