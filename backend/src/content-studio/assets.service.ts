import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

export interface RegisterAssetParams {
  organizationId: string;
  type: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT';
  source: 'GENERATED' | 'UPLOADED';
  url: string;
  storageKey?: string; // renseigné uniquement si l'objet est réellement stocké par nous
  fileName?: string;
  mimeType?: string;
  fileSizeBytes?: number;
  width?: number;
  height?: number;
  altText?: string;
  tags?: string[];
  generationId?: string; // trace vers AiGeneration si source=GENERATED
}

function inferAssetType(mimeType: string): 'IMAGE' | 'VIDEO' | 'DOCUMENT' {
  if (mimeType.startsWith('image/')) return 'IMAGE';
  if (mimeType.startsWith('video/')) return 'VIDEO';
  return 'DOCUMENT';
}

// Bibliothèque de médias du Content Studio : contrairement aux URLs éphémères jusqu'ici
// simplement posées dans AiGeneration.resultUrl, chaque asset est ici une entité réutilisable
// à travers les campagnes (un visuel qui a bien fonctionné peut être réemployé ailleurs),
// avec ses métadonnées (dimensions, tags, provenance) et sa traçabilité de génération.
@Injectable()
export class AssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  // Upload réel — auparavant absent, seul register() (URL déjà hébergée) existait. Reçoit
  // les octets directement (buffer mémoire, cf. FileInterceptor côté controller) et délègue
  // le stockage effectif à StorageService (S3-compatible ou disque local en dev).
  async uploadAndRegister(
    organizationId: string,
    file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
    metadata: { altText?: string; tags?: string[] },
  ) {
    const MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50 Mo — couvre la quasi-totalité des specs vidéo réseaux sociaux ;
    // un vrai upload de très gros fichiers gagnerait à passer par une URL présignée en upload
    // direct client → stockage plutôt que ce relai serveur, cf. roadmap.
    if (file.size > MAX_SIZE_BYTES) {
      throw new BadRequestException(`Fichier trop volumineux (${Math.round(file.size / 1024 / 1024)} Mo, maximum 50 Mo)`);
    }

    const { url, key } = await this.storage.upload(organizationId, file.buffer, file.originalname, file.mimetype);

    return this.register({
      organizationId,
      type: inferAssetType(file.mimetype),
      source: 'UPLOADED',
      url,
      storageKey: key,
      fileName: file.originalname,
      mimeType: file.mimetype,
      fileSizeBytes: file.size,
      altText: metadata.altText,
      tags: metadata.tags,
    });
  }

  async register(params: RegisterAssetParams) {
    return this.prisma.asset.create({
      data: {
        organizationId: params.organizationId,
        type: params.type as any,
        source: params.source as any,
        url: params.url,
        storageKey: params.storageKey,
        fileName: params.fileName,
        mimeType: params.mimeType,
        fileSizeBytes: params.fileSizeBytes,
        width: params.width,
        height: params.height,
        altText: params.altText,
        tags: (params.tags as any) ?? undefined,
        generationId: params.generationId,
      },
    });
  }

  async list(organizationId: string, filters: { type?: string; tag?: string; limit?: number }) {
    const results = await this.prisma.asset.findMany({
      where: {
        organizationId,
        ...(filters.type ? { type: filters.type as any } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filters.limit ?? 50, 200),
    });

    // Filtrage par tag effectué en mémoire plutôt qu'en requête Json Prisma (dont la syntaxe
    // varie selon la version) — acceptable au volume attendu d'une bibliothèque par organisation ;
    // à revoir avec une vraie table de jointure tags si le volume devient significatif.
    if (!filters.tag) return results;
    return results.filter((a) => Array.isArray(a.tags) && (a.tags as string[]).includes(filters.tag!));
  }

  async getById(organizationId: string, id: string) {
    const asset = await this.prisma.asset.findFirst({ where: { id, organizationId } });
    if (!asset) throw new NotFoundException('Asset introuvable');
    return asset;
  }

  async updateMetadata(organizationId: string, id: string, data: { altText?: string; tags?: string[] }) {
    await this.getById(organizationId, id); // vérifie l'appartenance avant modification
    return this.prisma.asset.update({
      where: { id },
      data: { altText: data.altText, tags: (data.tags as any) ?? undefined },
    });
  }

  async delete(organizationId: string, id: string) {
    const asset = await this.getById(organizationId, id);

    // Supprime l'objet réel du stockage AVANT la ligne en base — dans l'ordre inverse,
    // une panne de suppression laisserait une ligne fantôme pointant vers un objet déjà
    // supprimable mais non supprimé, alors que l'inverse (objet orphelin sans ligne) est
    // sans danger (juste un peu d'espace de stockage à nettoyer plus tard).
    // storageKey absent = asset enregistré par URL externe, jamais stocké par nous — rien à supprimer.
    if (asset.storageKey) {
      await this.storage.delete(asset.storageKey);
    }

    // Les ContentVersion qui référencent cet asset conservent leur assetId à null
    // (onDelete: SetNull dans le schéma) plutôt que de bloquer ou cascader la suppression du contenu.
    return this.prisma.asset.delete({ where: { id } });
  }
}
