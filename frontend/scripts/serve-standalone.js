// Sert le build de production exactement comme le fait frontend/Dockerfile — pas `next
// start`, qui ne fonctionne pas avec `output: "standalone"` (next.config.js). Le dossier
// .next/standalone ne contient ni .next/static ni public/ par construction (Next.js les
// exclut du bundle autonome pour permettre de les servir séparément, ex: via un CDN) : le
// Dockerfile les recopie explicitement à côté de server.js avant de démarrer. Ce script
// réplique la même étape pour que `npm run test:e2e` (local et CI, cf. playwright.config.ts)
// exerce le même artefact que celui réellement déployé, jamais un raccourci qui divergerait
// silencieusement de la production.
const { cpSync, existsSync } = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const standaloneDir = path.join(root, '.next', 'standalone');
const staticSrc = path.join(root, '.next', 'static');
const staticDest = path.join(standaloneDir, '.next', 'static');
const publicSrc = path.join(root, 'public');
const publicDest = path.join(standaloneDir, 'public');

cpSync(staticSrc, staticDest, { recursive: true });
if (existsSync(publicSrc)) cpSync(publicSrc, publicDest, { recursive: true });

const child = spawn(process.execPath, [path.join(standaloneDir, 'server.js')], {
  stdio: 'inherit',
  env: { ...process.env, PORT: process.env.PORT || '3000' },
});
child.on('exit', (code) => process.exit(code ?? 0));
