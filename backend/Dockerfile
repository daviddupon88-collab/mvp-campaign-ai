# Build multi-étapes : l'étape finale ne contient ni les devDependencies, ni le code
# source TypeScript, ni les outils de build — seulement le JS compilé et les dépendances
# de production, pour une image plus petite et une surface d'attaque réduite.

FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/
RUN npm install

COPY . .
RUN npm run prisma:generate
RUN npm run build

FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY prisma ./prisma/
RUN npm install --omit=dev && npm run prisma:generate

COPY --from=builder /app/dist ./dist

# Utilisateur non-root — une image qui tourne en root est une mauvaise pratique de
# sécurité de base, particulièrement pour un service qui manipule des tokens chiffrés
# et des secrets de paiement.
RUN addgroup -S campaignai && adduser -S campaignai -G campaignai
USER campaignai

EXPOSE 3001

# Healthcheck Docker natif, réutilise l'endpoint déjà construit pour Kubernetes —
# fonctionne aussi bien en simple `docker run` qu'en orchestrateur complet.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health/live', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/main.js"]
