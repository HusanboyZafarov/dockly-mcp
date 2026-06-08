FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc
RUN npm prune --omit=dev

ENV PORT=3100
EXPOSE 3100

CMD ["node", "dist/http.js"]
