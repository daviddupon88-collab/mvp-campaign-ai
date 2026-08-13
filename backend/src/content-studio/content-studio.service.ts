import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BrandLearningService } from '../brand/brand-learning.service';
import { BrandRuleGuardService } from '../brand/brand-rule-guard.service';
import { validateGoogleAdsBody } from './google-ads-body-guard';
import { diffWords } from './edit-diff.util';

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
  private readonly logger = new Logger(ContentStudioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly brandLearning: BrandLearningService,
    private readonly brandRuleGuard: BrandRuleGuardService,
  ) {}

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
    if (params.body) await this.validateTextBody(organizationId, piece, params.body);

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

    const updated = await this.prisma.contentPiece.update({
      where: { id: piece.id },
      data: { currentVersionId: version.id },
      include: { currentVersion: { include: { asset: true } } },
    });

    // Brand Brain (Phase 4) : capture la différence entre la version générée par l'IA et la
    // version approuvée par l'humain — jamais l'inverse (édition d'une édition déjà humaine),
    // ce qui n'apporte pas ce signal précis. Best-effort : un bug dans cette capture ne doit
    // jamais faire échouer une édition de contenu réelle.
    if (params.body) {
      try {
        await this.captureHumanEditObservations(organizationId, piece, params.body);
      } catch (error) {
        this.logger.warn(`Capture Brand Brain de l'édition (pièce ${pieceId}) échouée, édition non affectée : ${error}`);
      }
    }

    return updated;
  }

  // Point de passage unique pour tout corps de texte soumis manuellement (édition ou
  // variation) — avant cette correction (audit), createVariations() ne passait par AUCUN de
  // ces contrôles alors qu'editContent() les appliquait déjà : une variation pouvait dépasser
  // les limites Google Ads ou contenir un terme de marque interdit, puis être promue version
  // courante via selectVariationAsCurrent sans jamais avoir été bloquée.
  private async validateTextBody(
    organizationId: string,
    piece: { type: string; channel: string },
    body: string,
  ): Promise<void> {
    // Un contenu VIDEO n'a pas de corps texte éditable — currentVersion.body y est un champ
    // sans rapport avec l'asset vidéo réel (assetId). Éditer/varier "le texte" d'une vidéo
    // n'a jamais de sens et ne devrait jamais être exposé côté UI (cf. frontend), mais on
    // refuse aussi explicitement côté API pour ne dépendre d'aucun garde-fou côté client.
    if (piece.type === 'VIDEO') {
      throw new BadRequestException("Impossible d'éditer ou de créer une variation textuelle sur un contenu vidéo.");
    }

    // La génération IA applique déjà les limites 30/90 caractères (troncature automatique,
    // cf. AiOrchestratorService.parseGoogleAdsContent) — sans ce contrôle, une soumission
    // manuelle pouvait les dépasser silencieusement et produire une annonce rejetée par
    // Google Ads au moment de la publication réelle.
    if (piece.channel === 'googleads') {
      validateGoogleAdsBody(body);
    }

    // Brand Brain (Phase 11) : une RULE active ne dépend jamais uniquement du prompt de
    // génération — un terme explicitement interdit (metadata.forbiddenTerms) est bloqué ici
    // par du code, y compris sur une soumission manuelle qui n'est jamais passée par l'IA.
    const violations = await this.brandRuleGuard.checkText(organizationId, body, { channel: piece.channel });
    if (violations.length > 0) {
      const [first] = violations;
      throw new BadRequestException(
        `Contenu refusé — règle de marque enfreinte : "${first.ruleContent}" (terme interdit détecté : "${first.matchedTerm}").`,
      );
    }
  }

  // Une seule voie d'entrée pour toute observation dérivée d'une édition manuelle — ne
  // capture QUE le passage IA -> humain (previousVersion.createdByUserId absent), pas une
  // édition humaine sur une édition humaine, qui n'a pas la même valeur de signal
  // (cf. Phase 4 : "AI GENERATED VERSION et USER APPROVED VERSION").
  private async captureHumanEditObservations(
    organizationId: string,
    piece: { id: string; channel: string; campaignId: string; currentVersion: { body: string | null; createdByUserId: string | null } | null },
    newBody: string,
  ) {
    const previousVersion = piece.currentVersion;
    if (!previousVersion?.body || previousVersion.createdByUserId || previousVersion.body === newBody) return;

    const { removed, added } = diffWords(previousVersion.body, newBody);

    for (const word of removed) {
      await this.brandLearning.recordObservation({
        organizationId,
        type: 'LEARNING',
        category: 'COPY',
        scope: 'CHANNEL',
        channel: piece.channel,
        content: `Le mot « ${word} » généré par l'IA est régulièrement retiré lors des éditions manuelles sur ${piece.channel}.`,
        dedupKey: `edit-removed:${piece.channel}:${word}`,
        signal: 'positive', // confirme le pattern "ce mot tend à être retiré", pas la campagne
        source: 'content_studio_edit',
        sourceId: piece.id,
        sourceCampaignId: piece.campaignId,
      });
    }

    for (const word of added) {
      await this.brandLearning.recordObservation({
        organizationId,
        type: 'LEARNING',
        category: 'COPY',
        scope: 'CHANNEL',
        channel: piece.channel,
        content: `Le mot « ${word} » est régulièrement ajouté par les utilisateurs lors des éditions manuelles sur ${piece.channel}.`,
        dedupKey: `edit-added:${piece.channel}:${word}`,
        signal: 'positive',
        source: 'content_studio_edit',
        sourceId: piece.id,
        sourceCampaignId: piece.campaignId,
      });
    }
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

    // Toutes les variations sont validées AVANT que la moindre ne soit créée — pas de
    // création partielle d'un lot dont une variation ultérieure aurait été refusée.
    for (const v of variations) {
      if (v.body) await this.validateTextBody(organizationId, piece, v.body);
    }

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
