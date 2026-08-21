import * as fs from 'fs';
import * as path from 'path';

// Mission 4 Phase E (Correction obligatoire 5, TEST 14) — le benchmark TTS isolé
// (mission4-tts-benchmark.ts) ne doit JAMAIS être importé/référencé par un fichier du chemin
// d'exécution normal d'une campagne. Vérification STATIQUE (analyse du code source, pas un mock
// d'exécution) : une génération de campagne standard ne peut structurellement pas déclencher ce
// script si aucun fichier de production ne le référence.
// Détecte une véritable dépendance de CODE (import ES/CommonJS) vers le script — jamais une
// simple MENTION dans un commentaire de documentation (plusieurs fichiers expliquent
// légitimement "ce champ n'existe que pour le benchmark isolé, cf. mission4-tts-benchmark.ts" :
// cette documentation est saine, la règle interdit l'IMPORT, pas la mention textuelle).
const IMPORT_PATTERN = /(?:from\s+['"][^'"]*mission4-tts-benchmark['"])|(?:require\(\s*['"][^'"]*mission4-tts-benchmark['"]\s*\))/;

const PRODUCTION_ENTRY_POINTS = [
  path.join(__dirname, '..', 'ai', 'ai-gateway', 'providers', 'openai.provider.ts'),
  path.join(__dirname, '..', 'ai', 'video-judge', 'video-quality-loop.service.ts'),
  path.join(__dirname, '..', 'queue', 'campaign-generation.processor.ts'),
];

describe('Mission 4 Phase E — isolation du benchmark TTS (TEST 14)', () => {
  it('le benchmark n\'est IMPORTÉ par AUCUN fichier du chemin d\'exécution normal d\'une campagne', () => {
    for (const filePath of PRODUCTION_ENTRY_POINTS) {
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).not.toMatch(IMPORT_PATTERN);
    }
  });

  it("aucun fichier de tout le backend (hors ce script lui-même) n'IMPORTE le benchmark — balayage large, pas seulement les 3 entrées connues", () => {
    const srcRoot = path.join(__dirname, '..', '..', 'src');
    const offenders: string[] = [];

    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') continue;
          walk(full);
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
          if (path.basename(full) === 'mission4-tts-benchmark.ts') continue; // le script lui-même
          const content = fs.readFileSync(full, 'utf-8');
          if (IMPORT_PATTERN.test(content)) offenders.push(full);
        }
      }
    }
    walk(srcRoot);

    expect(offenders).toEqual([]);
  });

  it('le script existe bien à l\'emplacement attendu (sanity check — sinon les 2 tests ci-dessus seraient trivialement vrais)', () => {
    const scriptPath = path.join(__dirname, 'mission4-tts-benchmark.ts');
    expect(fs.existsSync(scriptPath)).toBe(true);
  });
});
