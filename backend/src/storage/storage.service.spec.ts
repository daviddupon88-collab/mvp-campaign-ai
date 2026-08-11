import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StorageService } from './storage.service';

function buildLocalService(localDir: string): StorageService {
  const values: Record<string, string> = {
    STORAGE_PROVIDER: 'local',
    STORAGE_LOCAL_DIR: localDir,
    API_PUBLIC_URL: 'http://localhost:3001',
  };
  const config = { get: (key: string, fallback?: string) => values[key] ?? fallback } as unknown as ConfigService;
  return new StorageService(config);
}

describe('StorageService (mode local)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-ai-storage-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('écrit le fichier sur le disque et retourne une URL publique cohérente', async () => {
    const service = buildLocalService(tmpDir);
    const result = await service.upload('org-1', Buffer.from('contenu-test'), 'logo.png', 'image/png');

    expect(result.key).toMatch(/^org-1\//);
    expect(result.url).toBe(`http://localhost:3001/uploads/${result.key}`);
    expect(fs.existsSync(path.join(tmpDir, result.key))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, result.key), 'utf8')).toBe('contenu-test');
  });

  it('génère une clé différente à chaque upload, même pour un nom de fichier identique', async () => {
    const service = buildLocalService(tmpDir);
    const first = await service.upload('org-1', Buffer.from('a'), 'photo.png', 'image/png');
    const second = await service.upload('org-1', Buffer.from('b'), 'photo.png', 'image/png');
    expect(first.key).not.toBe(second.key);
  });

  it('supprime réellement le fichier du disque', async () => {
    const service = buildLocalService(tmpDir);
    const result = await service.upload('org-1', Buffer.from('à supprimer'), 'temp.txt', 'text/plain');
    expect(fs.existsSync(path.join(tmpDir, result.key))).toBe(true);

    await service.delete(result.key);
    expect(fs.existsSync(path.join(tmpDir, result.key))).toBe(false);
  });

  it('la suppression d\'une clé déjà absente ne lève pas d\'exception (idempotent)', async () => {
    const service = buildLocalService(tmpDir);
    await expect(service.delete('org-1/inexistant.png')).resolves.toBeUndefined();
  });

  it('assainit les noms de fichiers dangereux (traversée de répertoire, caractères spéciaux)', async () => {
    const service = buildLocalService(tmpDir);
    const result = await service.upload('org-1', Buffer.from('x'), '../../etc/passwd', 'text/plain');
    // La clé ne doit jamais permettre de sortir du répertoire de stockage.
    expect(result.key).not.toContain('..');
    expect(fs.existsSync(path.join(tmpDir, result.key))).toBe(true);
  });

  it('isLocalMode() reflète correctement le mode configuré', () => {
    const service = buildLocalService(tmpDir);
    expect(service.isLocalMode()).toBe(true);
  });
});

describe('StorageService.uploadFromUrl', () => {
  it('retourne null (jamais une exception) si l\'URL source est inaccessible', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-ai-storage-test-'));
    const service = buildLocalService(tmpDir);

    // URL garantie invalide — simule une URL de fournisseur IA déjà expirée.
    const result = await service.uploadFromUrl('org-1', 'https://this-domain-does-not-exist-campaignai-test.invalid/image.png');

    expect(result).toBeNull();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
