FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

# next.config.js (output: 'standalone') produit un serveur Node autonome avec uniquement
# les dépendances réellement tracées à l'exécution — plus besoin de réinstaller
# node_modules dans l'image finale (npm install --omit=dev supprimé), image sensiblement
# plus légère qu'un `next start` classique (README item 52).
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# Pas de dossier public/ dans ce scaffold à ce stade — à ajouter ici si des assets
# statiques (logo, favicon) sont introduits ultérieurement :
# COPY --from=builder /app/public ./public

RUN addgroup -S campaignai && adduser -S campaignai -G campaignai
USER campaignai

EXPOSE 3000
CMD ["node", "server.js"]
