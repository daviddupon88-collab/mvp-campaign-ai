import * as fs from 'fs';
import * as path from 'path';

// Mission 4.5 (stabilisation infrastructure, 2026-08-22) — observabilité minimale PERSISTANTE
// du process, ajoutée après un arrêt silencieux du backend sans aucune trace exploitable (le
// process tournait depuis une session antérieure, sa sortie standard n'était redirigée nulle
// part). Module PLAT (pas de service NestJS) : doit rester utilisable depuis main.ts AVANT que
// le conteneur NestJS ne soit disponible (les handlers process.on('uncaughtException'/...) sont
// enregistrés au chargement du module, hors de tout contexte de requête/DI).
//
// Écriture SYNCHRONE (fs.appendFileSync) délibérée : un uncaughtException est suivi d'un
// process.exit() volontaire quelques dizaines de ms plus tard (cf. main.ts) — une écriture
// asynchrone pourrait ne jamais atteindre le disque avant que le process ne meure. Le coût de
// blocage de l'event loop est négligeable ici : ce chemin n'est emprunté qu'à l'arrêt du
// process ou pour quelques événements peu fréquents (job de campagne, erreur worker), jamais
// sur le chemin chaud d'une requête HTTP normale.
const LOG_DIR = path.join(__dirname, '..', '..', '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'process-health.log');
const MAX_RECENT_ACTIVITY = 20;

interface ActivityEntry {
  at: string;
  event: string;
  details?: Record<string, unknown>;
}

// État en mémoire — perdu si le process meurt brutalement AVANT qu'un handler n'ait eu la
// chance de le lire (cas d'un OOM tuant le process sans même déclencher uncaughtException) ;
// c'est pourquoi getProcessSnapshot()/getRecentActivity() sont TOUJOURS appelés depuis
// l'intérieur d'un handler qui tourne encore dans le MÊME process, jamais reconstruits après coup.
const recentActivity: ActivityEntry[] = [];

function ensureLogDir(): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // Répertoire déjà existant ou non créable (permissions) — logProcessEvent gère lui-même
    // l'échec d'écriture juste après, jamais un throw ici qui casserait l'appelant.
  }
}

// Suivi léger du dernier contexte connu (campagne/job/appel IA/erreur HTTP) — répond
// spécifiquement à "dernière campagne et dernier événement connus" + "correlation ID campagne"
// du brief : en cas de crash, le handler uncaughtException lit cet état pour savoir CE QUI se
// passait juste avant, même si la stack de l'exception elle-même ne le dit pas (ex : une erreur
// de connexion Redis levée par le Worker BullMQ en tâche de fond, sans lien direct avec le job
// en cours).
export function recordActivity(event: string, details?: Record<string, unknown>): void {
  recentActivity.push({ at: new Date().toISOString(), event, details });
  if (recentActivity.length > MAX_RECENT_ACTIVITY) recentActivity.shift();
}

export function getRecentActivity(): ActivityEntry[] {
  return [...recentActivity];
}

export function getProcessSnapshot(): Record<string, unknown> {
  const mem = process.memoryUsage();
  return {
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    memory: {
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      externalMb: Math.round(mem.external / 1024 / 1024),
    },
  };
}

// Point d'entrée UNIQUE pour tout événement destiné à survivre à un crash — inclut
// systématiquement le snapshot process + l'activité récente, pour qu'une seule ligne du fichier
// suffise à reconstituer le contexte, sans avoir à recouper plusieurs sources après coup.
export function logProcessEvent(type: string, payload: Record<string, unknown> = {}): void {
  ensureLogDir();
  const line = {
    at: new Date().toISOString(),
    type,
    ...payload,
    process: getProcessSnapshot(),
    recentActivity: getRecentActivity(),
  };
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(line) + '\n');
  } catch (err) {
    // Dernier recours : la persistance elle-même a échoué (disque plein, permissions) — au
    // moins visible sur stdout si le process survit assez longtemps pour qu'on le lise.
    console.error('[process-health] Échec d\'écriture du journal persistant :', err);
  }
  // Toujours ÉGALEMENT sur stdout/stderr — utile en dev quand un terminal interactif observe
  // le process en direct, sans dépendre uniquement du fichier.
  console.error(`[process-health:${type}]`, JSON.stringify(payload));
}

export function serializeError(error: unknown): { message: string; stack?: string; name?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack, name: error.name };
  }
  if (typeof error === 'object' && error !== null) {
    try {
      return { message: JSON.stringify(error) };
    } catch {
      return { message: String(error) };
    }
  }
  return { message: String(error) };
}
