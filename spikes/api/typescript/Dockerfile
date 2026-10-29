FROM node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e
WORKDIR /lab
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY spikes/api/typescript ./spikes/api/typescript
RUN npm run build:spike
USER node
CMD ["node", "dist/typescript/server.js"]
