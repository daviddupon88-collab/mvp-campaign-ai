FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/.next ./.next
# Pas de dossier public/ dans ce scaffold à ce stade — à ajouter ici si des assets
# statiques (logo, favicon) sont introduits ultérieurement.

RUN addgroup -S campaignai && adduser -S campaignai -G campaignai
USER campaignai

EXPOSE 3000
CMD ["npm", "start"]
