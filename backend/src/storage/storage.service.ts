import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface UploadResult {
  url: string;
  key: string;
}

// Stockage d'objets réel — auparavant, POST /assets se contentait d'enregistrer une URL déjà
// hébergée ailleurs (l'upload lui-même n'existait pas). Un seul client, celui d'AWS S3, suffit
// à couvrir S3, Cloudflare R2, Google Cloud Storage (mode interopérabilité S3), MinIO et
// Backblaze B2 : tous exposent une API compatible S3, seule l'URL d'endpoint change — c'est
// ce qui permet à cette implémentation unique de servir n'importe lequel de ces fournisseurs
// selon la configuration, sans code spécifique par fournisseur.
//
// STORAGE_PROVIDER=local (par défaut) : écrit sur le disque du conteneur et sert les fichiers
// via une route statique — permet de développer et tester sans compte cloud, même principe
// que AI_MODE=mock. À ne jamais utiliser en production (le disque d'un conteneur n'est pas
// durable ni partagé entre plusieurs instances).
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly mode: 'local' | 's3';
  private readonly s3: S3Client | null = null;
  private readonly bucket: string;
  private readonly publicUrlBase: string;
  private readonly localDir: string;

  constructor(private readonly config: ConfigService) {
    this.mode = this.config.get<string>('STORAGE_PROVIDER', 'local') === 's3' ? 's3' : 'local';
    this.bucket = this.config.get<string>('STORAGE_BUCKET', '');
    this.localDir = this.config.get<string>('STORAGE_LOCAL_DIR', path.join(process.cwd(), 'uploads'));

    if (this.mode === 's3') {
      this.publicUrlBase = this.config.get<string>('STORAGE_PUBLIC_URL_BASE', '').replace(/\/$/, '');
      this.s3 = new S3Client({
        region: this.config.get<string>('STORAGE_REGION', 'auto'),
        endpoint: this.config.get<string>('STORAGE_ENDPOINT') || undefined, // requis pour R2/MinIO/B2 ; absent = AWS S3 standard
        forcePathStyle: this.config.get<string>('STORAGE_FORCE_PATH_STYLE') === 'true', // requis pour MinIO et certaines configurations R2
        credentials: {
          accessKeyId: this.config.get<string>('STORAGE_ACCESS_KEY_ID', ''),
          secretAccessKey: this.config.get<string>('STORAGE_SECRET_ACCESS_KEY', ''),
        },
      });
    } else {
      this.publicUrlBase = `${this.config.get<string>('API_PUBLIC_URL', 'http://localhost:3001')}/uploads`;
      fs.mkdirSync(this.localDir, { recursive: true });
      this.logger.warn(
        'STORAGE_PROVIDER=local — fichiers stockés sur le disque du conteneur, non durable. ' +
          'À ne jamais utiliser en production (cf. STORAGE_PROVIDER=s3 dans .env.example).',
      );
    }
  }

  private buildKey(organizationId: string, fileName: string): string {
    // Ne garde que le dernier segment du nom fourni — un nom contenant une tentative de
    // traversée de répertoire (`../../etc/passwd`) est ainsi neutralisé en amont plutôt que
    // simplement "nettoyé" caractère par caractère (une regex qui ne supprime que les `/`
    // laisserait passer les `..` littéraux, toujours dangereux une fois recombinés).
    const baseName = fileName.split(/[/\\]/).pop() || 'file';
    const safeName = baseName.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(-100) || 'file';
    // Préfixé par organizationId même si l'accès réel est contrôlé au niveau de la ligne
    // Asset en base (organizationId y est vérifié) — défense en profondeur, pas le seul
    // rempart : une clé prévisible ne doit jamais être le seul mécanisme d'isolation tenant.
    return `${organizationId}/${randomUUID()}-${safeName}`;
  }

  async upload(organizationId: string, buffer: Buffer, fileName: string, mimeType: string): Promise<UploadResult> {
    const key = this.buildKey(organizationId, fileName);

    if (this.mode === 's3') {
      await this.s3!.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: buffer, ContentType: mimeType }));
    } else {
      const filePath = path.join(this.localDir, key);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, buffer);
    }

    return { url: `${this.publicUrlBase}/${key}`, key };
  }

  // Re-héberge une URL externe (typiquement une URL temporaire renvoyée par un fournisseur
  // d'IA — OpenAI, Flux, Ideogram, Google Veo expirent toutes leurs URLs de génération après
  // quelques heures) vers notre propre stockage permanent. Retourne null en cas d'échec
  // (timeout, URL déjà expirée, contenu factice en mode mock) plutôt que de lever une
  // exception : l'appelant doit pouvoir se rabattre sur l'URL d'origine sans faire échouer
  // toute la génération de campagne pour un problème de re-hébergement.
  async uploadFromUrl(organizationId: string, sourceUrl: string, fileNameHint = 'asset'): Promise<UploadResult | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      const response = await fetch(sourceUrl, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const mimeType = response.headers.get('content-type') ?? 'application/octet-stream';
      const extension = mimeType.split('/')[1]?.split(';')[0] ?? 'bin';

      return await this.upload(organizationId, buffer, `${fileNameHint}.${extension}`, mimeType);
    } catch (error) {
      this.logger.warn(`Échec du re-hébergement de ${sourceUrl}: ${error} — l'URL d'origine sera conservée telle quelle`);
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    if (this.mode === 's3') {
      await this.s3!.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } else {
      const filePath = path.join(this.localDir, key);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  }

  // Utilisé par main.ts pour savoir s'il doit monter la route statique de service des
  // fichiers locaux — inutile (et une confusion potentielle) en mode s3.
  isLocalMode(): boolean {
    return this.mode === 'local';
  }

  getLocalDir(): string {
    return this.localDir;
  }
}
