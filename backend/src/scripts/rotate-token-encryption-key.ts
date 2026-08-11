// Rotation de TOKEN_ENCRYPTION_KEY — README item 20/38 (« rotation non implémentée »).
// Déchiffre chaque token stocké (SocialConnection, StoreConnection) sous l'ancienne clé et
// le rechiffre sous la nouvelle, sans jamais faire transiter le texte en clair par un log
// ou une sortie standard.
//
// Usage (développement, via ts-node) :
//   OLD_TOKEN_ENCRYPTION_KEY=... NEW_TOKEN_ENCRYPTION_KEY=... DATABASE_URL=... \
//     npx ts-node src/scripts/rotate-token-encryption-key.ts [--dry-run]
//
// Usage (production, après `npm run build` — ts-node est une devDependency, absente de
// l'image Docker de production) :
//   OLD_TOKEN_ENCRYPTION_KEY=... NEW_TOKEN_ENCRYPTION_KEY=... DATABASE_URL=... \
//     node dist/scripts/rotate-token-encryption-key.js [--dry-run]
//
// Étapes de rotation recommandées :
//   1. Générer la nouvelle clé : openssl rand -base64 32
//   2. Exécuter ce script en --dry-run d'abord (aucune écriture, juste un rapport).
//   3. Exécuter sans --dry-run pendant une fenêtre de maintenance (le script ne verrouille
//      pas les lignes — une connexion créée/rafraîchie PENDANT la rotation, avec l'ancienne
//      clé encore active côté app, resterait cohérente ; mais éviter un déploiement
//      concurrent qui basculerait déjà TOKEN_ENCRYPTION_KEY vers la nouvelle valeur avant la
//      fin du script).
//   4. Déployer TOKEN_ENCRYPTION_KEY=<nouvelle clé> sur l'application.
//   5. Vérifier (ex: reconnexion d'un compte test) puis détruire l'ancienne clé.

import { PrismaClient } from '@prisma/client';
import { TokenCryptoService } from '../common/crypto/token-crypto.service';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Variable d'environnement requise absente : ${name}`);
    process.exit(1);
  }
  return value;
}

function buildCryptoService(key: string): TokenCryptoService {
  const fakeConfig = { get: (_k: string) => key } as any;
  return new TokenCryptoService(fakeConfig);
}

// Logique pure, testée isolément (rotate-token-encryption-key.spec.ts) sans toucher à la
// base : déchiffre sous l'ancienne clé puis rechiffre sous la nouvelle. Une valeur déjà en
// clair (pas 3 segments iv:tag:ciphertext — cf. TokenCryptoService.decrypt) est laissée
// telle quelle, jamais chiffrée de force par ce script (ce n'est pas son rôle).
export function rotateStoredValue(
  oldCrypto: TokenCryptoService,
  newCrypto: TokenCryptoService,
  stored: string | null,
): { value: string | null; changed: boolean } {
  if (!stored) return { value: stored, changed: false };
  const parts = stored.split(':');
  if (parts.length !== 3) return { value: stored, changed: false };
  const plaintext = oldCrypto.decrypt(stored);
  return { value: newCrypto.encrypt(plaintext), changed: true };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const oldKey = requireEnv('OLD_TOKEN_ENCRYPTION_KEY');
  const newKey = requireEnv('NEW_TOKEN_ENCRYPTION_KEY');
  if (oldKey === newKey) {
    console.error('OLD_TOKEN_ENCRYPTION_KEY et NEW_TOKEN_ENCRYPTION_KEY sont identiques — rien à faire.');
    process.exit(1);
  }

  const oldCrypto = buildCryptoService(oldKey);
  const newCrypto = buildCryptoService(newKey);
  const prisma = new PrismaClient();

  let rotated = 0;
  let skipped = 0; // déjà en clair ou déjà sous la nouvelle clé — pas de rotation nécessaire
  let failed = 0;

  const reencrypt = (stored: string | null) => rotateStoredValue(oldCrypto, newCrypto, stored);

  try {
    const socialConnections = await prisma.socialConnection.findMany({
      select: { id: true, accessToken: true, refreshToken: true },
    });

    for (const conn of socialConnections) {
      try {
        const accessToken = reencrypt(conn.accessToken);
        const refreshToken = reencrypt(conn.refreshToken);
        if (!accessToken.changed && !refreshToken.changed) {
          skipped++;
          continue;
        }
        if (!dryRun) {
          await prisma.socialConnection.update({
            where: { id: conn.id },
            data: { accessToken: accessToken.value!, refreshToken: refreshToken.value },
          });
        }
        rotated++;
      } catch (error) {
        failed++;
        console.error(`Échec de rotation SocialConnection ${conn.id}: ${error}`);
      }
    }

    const storeConnections = await prisma.storeConnection.findMany({
      select: { id: true, accessToken: true, apiKey: true, apiSecret: true },
    });

    for (const conn of storeConnections) {
      try {
        const accessToken = reencrypt(conn.accessToken);
        const apiKey = reencrypt(conn.apiKey);
        const apiSecret = reencrypt(conn.apiSecret);
        if (!accessToken.changed && !apiKey.changed && !apiSecret.changed) {
          skipped++;
          continue;
        }
        if (!dryRun) {
          await prisma.storeConnection.update({
            where: { id: conn.id },
            data: { accessToken: accessToken.value, apiKey: apiKey.value, apiSecret: apiSecret.value },
          });
        }
        rotated++;
      } catch (error) {
        failed++;
        console.error(`Échec de rotation StoreConnection ${conn.id}: ${error}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(`${dryRun ? '[DRY RUN] ' : ''}Rotation terminée — ${rotated} connexion(s) rechiffrée(s), ${skipped} déjà à jour ou en clair, ${failed} échec(s).`);
  if (failed > 0) process.exit(1);
}

// Ne s'exécute que lancé directement (ts-node ou node dist/...), jamais quand
// rotateStoredValue() est importé pour être testé unitairement (cf.
// rotate-token-encryption-key.spec.ts) — sans ce garde, importer ce fichier depuis un test
// échouerait immédiatement sur les variables d'environnement manquantes.
if (require.main === module) {
  main();
}
