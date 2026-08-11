import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface CreatePieceParams {
  organizationId: string;
  campaignId: string;
  channel: string;
  type: 'TEXT' | 'IMAGE' | 'VIDEO' | 'EMAIL' | 'LANDING_PAGE';
  body?: string;
  assetId?: string;
  createdByUserId?: string;
}

export interface EditVersionParams {
  body?: string;
  assetId?: string;
  changeNote?: string;
  createdByUserId?: string;
}

export interface CreateVariationParams {
  label: string; // "A" | "B" | "C"...
  body?: string;
  assetId?: string;
  createdByUserId?: string;
}

// Content Studio (Module 10/11 étendus) : gère le cycle de vie complet d'un contenu de
// campagne — au-delà du simple blob texte produit par l'AI Orchestrator, chaque pièce a
// un historique de versions (jamais d'écrasement) et peut porter plusieurs variations
// concurrentes (A/B) avant de choisir laquelle devient la version courante à publier.
@Injectable()
export class ContentStudioService {
  constructor(private readonly prisma: PrismaService) {}

  async listForCampaign(organizationId: string, campaignId: string) {
    return this.prisma.contentPiece.findMany({
      where: { organizationId, campaignId },
      include: { currentVersion: { include: { asset: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getById(organizationId: string, id: string) {
    const piece = await this.prisma.contentPiece.findFirst({
      where: { id, organizationId },
      include: {
        currentVersion: { include: { asset: true } },
        versions: { include: { asset: true }, orderBy: [{ versionNumber: 'asc' }, { label: 'asc' }] },
      },
    });
    if (!piece) throw new NotFoundException('Contenu introuvable');
    return piece;
  }

  // Crée une pièce de contenu avec sa première version (versionNumber=1, label=null).
  // C'est le point d'entrée utilisé par le worker de génération pour persister ce que
  // l'AI Orchestrator produit — auparavant, ce contenu n'était jamais conservé au-delà
  // du résultat transitoire renvoyé par l'appel IA.
  async createPiece(params: CreatePieceParams) {
    const piece = await this.prisma.contentPiece.create({
      data: {
        organizationId: params.organizationId,
        campaignId: params.campaignId,
        channel: params.channel,
        type: params.type as any,
        status: 'DRAFT',
      },
    });

    const version = await this.prisma.contentVersion.create({
      data: {
        contentPieceId: piece.id,
        versionNumber: 1,
        body: params.body,
        assetId: params.assetId,
        createdByUserId: params.createdByUserId,
      },
    });

    return this.prisma.contentPiece.update({
      where: { id: piece.id },
      data: { currentVersionId: version.id, status: 'READY' },
      include: { currentVersion: true },
    });
  }

  // Édite le contenu : crée une NOUVELLE version (jamais de mutation sur l'existante) et la
  // fait devenir la version courante. L'historique complet reste consultable via getById().
  async editContent(organizationId: string, pieceId: string, params: EditVersionParams) {
    const piece = await this.getById(organizationId, pieceId);
    const nextVersionNumber = Math.max(0, ...piece.versions.filter((v) => !v.label).map((v) => v.versionNumber)) + 1;

    const version = await this.prisma.contentVersion.create({
      data: {
        contentPieceId: piece.id,
        versionNumber: nextVersionNumber,
        body: params.body ?? piece.currentVersion?.body,
        assetId: params.assetId ?? piece.currentVersion?.assetId,
        changeNote: params.changeNote,
        createdByUserId: params.createdByUserId,
      },
    });

    return this.prisma.contentPiece.update({
      where: { id: piece.id },
      data: { currentVersionId: version.id },
      include: { currentVersion: { include: { asset: true } } },
    });
  }

  // Crée une ou plusieurs variations concurrentes à comparer côte à côte — typiquement
  // plusieurs angles créatifs générés en une passe (cf. AiOrchestratorService), regroupées
  // par variantGroup pour un affichage groupé côté frontend. Aucune ne devient
  // automatiquement la version courante : un choix humain explicite est requis
  // (cf. selectVariationAsCurrent), cohérent avec le principe "l'IA propose, l'humain décide"
  // déjà appliqué à la modération et à l'Optimizer.
  async createVariations(organizationId: string, pieceId: string, variations: CreateVariationParams[]) {
    if (variations.length === 0) throw new BadRequestException('Au moins une variation est requise');
    const piece = await this.getById(organizationId, pieceId);

    const variantGroup = Math.floor(Date.now() / 1000); // identifiant de regroupement simple mais suffisant
    const baseVersionNumber = Math.max(0, ...piece.versions.map((v) => v.versionNumber));

    const created = await Promise.all(
      variations.map((v) =>
        this.prisma.contentVersion.create({
          data: {
            contentPieceId: piece.id,
            versionNumber: baseVersionNumber, // même numéro : ce sont des alternatives, pas une progression
            label: v.label,
            variantGroup,
            body: v.body,
            assetId: v.assetId,
            createdByUserId: v.createdByUserId,
          },
        }),
      ),
    );

    return created;
  }

  // Promeut une variation (ou une ancienne version) au rang de version courante — c'est le
  // moment de décision humaine qui suit createVariations().
  async selectVariationAsCurrent(organizationId: string, pieceId: string, versionId: string) {
    const piece = await this.getById(organizationId, pieceId);
    const version = piece.versions.find((v) => v.id === versionId);
    if (!version) throw new NotFoundException('Version introuvable pour ce contenu');

    return this.prisma.contentPiece.update({
      where: { id: piece.id },
      data: { currentVersionId: version.id },
      include: { currentVersion: { include: { asset: true } } },
    });
  }

  async archive(organizationId: string, pieceId: string) {
    await this.getById(organizationId, pieceId);
    return this.prisma.contentPiece.update({ where: { id: pieceId }, data: { status: 'ARCHIVED' } });
  }
}
