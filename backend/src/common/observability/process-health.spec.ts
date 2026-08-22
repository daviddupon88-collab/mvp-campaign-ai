import * as fs from 'fs';
import * as path from 'path';

// Mission 4.5 (stabilisation infrastructure, 2026-08-22) — chaque test réimporte le module à
// neuf (jest.resetModules) pour repartir d'un buffer d'activité vide : recentActivity est un
// état module-level partagé, comme documenté dans process-health.ts lui-même.
describe('process-health', () => {
  const LOG_FILE = path.join(__dirname, '..', '..', '..', 'logs', 'process-health.log');

  function freshModule() {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./process-health') as typeof import('./process-health');
  }

  afterEach(() => {
    if (fs.existsSync(LOG_FILE)) fs.rmSync(LOG_FILE);
  });

  describe('recordActivity / getRecentActivity', () => {
    it('conserve les événements dans l\'ordre chronologique', () => {
      const { recordActivity, getRecentActivity } = freshModule();
      recordActivity('a');
      recordActivity('b', { x: 1 });

      const activity = getRecentActivity();
      expect(activity.map((a) => a.event)).toEqual(['a', 'b']);
      expect(activity[1].details).toEqual({ x: 1 });
    });

    it('borné à 20 entrées — ne grossit jamais indéfiniment (fuite mémoire évitée)', () => {
      const { recordActivity, getRecentActivity } = freshModule();
      for (let i = 0; i < 30; i++) recordActivity(`event-${i}`);

      const activity = getRecentActivity();
      expect(activity).toHaveLength(20);
      expect(activity[0].event).toBe('event-10'); // les 10 plus anciens ont été éjectés
      expect(activity[19].event).toBe('event-29');
    });

    it("getRecentActivity() renvoie une COPIE — muter le résultat n'affecte pas l'état interne", () => {
      const { recordActivity, getRecentActivity } = freshModule();
      recordActivity('a');
      const activity = getRecentActivity();
      activity.push({ at: 'x', event: 'injected' });

      expect(getRecentActivity()).toHaveLength(1);
    });
  });

  describe('getProcessSnapshot', () => {
    it('expose pid/uptime/mémoire sous une forme exploitable', () => {
      const { getProcessSnapshot } = freshModule();
      const snapshot = getProcessSnapshot();

      expect(snapshot.pid).toBe(process.pid);
      expect(typeof snapshot.uptimeSeconds).toBe('number');
      expect((snapshot.memory as any).rssMb).toBeGreaterThan(0);
    });
  });

  describe('logProcessEvent — persistance disque SYNCHRONE (survit à un process.exit() immédiat)', () => {
    it('écrit une ligne JSON valide et lisible dans le fichier de log', () => {
      const { logProcessEvent } = freshModule();
      logProcessEvent('uncaughtException', { error: { message: 'panne test' } });

      expect(fs.existsSync(LOG_FILE)).toBe(true);
      const lines = fs.readFileSync(LOG_FILE, 'utf-8').trim().split('\n');
      const parsed = JSON.parse(lines[lines.length - 1]);
      expect(parsed.type).toBe('uncaughtException');
      expect(parsed.error.message).toBe('panne test');
      expect(parsed.process.pid).toBe(process.pid);
    });

    it('inclut l\'activité récente au moment de l\'écriture — reconstitue le contexte sans recouper plusieurs sources', () => {
      const { recordActivity, logProcessEvent } = freshModule();
      recordActivity('campaign_job_started', { campaignId: 'camp-1' });
      logProcessEvent('bullmq_worker_error', { error: { message: 'redis lost' } });

      const lines = fs.readFileSync(LOG_FILE, 'utf-8').trim().split('\n');
      const parsed = JSON.parse(lines[lines.length - 1]);
      expect(parsed.recentActivity).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'campaign_job_started' })]));
    });

    it('plusieurs appels successifs accumulent des lignes distinctes, jamais un écrasement', () => {
      const { logProcessEvent } = freshModule();
      logProcessEvent('signal', { signal: 'SIGTERM' });
      logProcessEvent('unhandledRejection', { error: { message: 'x' } });

      const lines = fs.readFileSync(LOG_FILE, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
    });
  });

  describe('serializeError', () => {
    it('conserve message/stack/name pour une vraie Error', () => {
      const { serializeError } = freshModule();
      const err = new TypeError('mauvais type');

      const serialized = serializeError(err);

      expect(serialized.name).toBe('TypeError');
      expect(serialized.message).toBe('mauvais type');
      expect(serialized.stack).toContain('TypeError');
    });

    it("gère une valeur rejetée qui n'est pas une Error (ex: string/objet brut) sans planter", () => {
      const { serializeError } = freshModule();
      expect(serializeError('panne brute').message).toBe('panne brute');
      expect(serializeError({ code: 42 }).message).toContain('42');
    });
  });
});
