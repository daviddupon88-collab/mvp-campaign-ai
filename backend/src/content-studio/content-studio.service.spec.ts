import { BadRequestException } from '@nestjs/common';
import { ContentStudioService } from './content-studio.service';
import { PrismaService } from '../prisma/prisma.service';
import { BrandLearningService } from '../brand/brand-learning.service';
import { BrandRuleGuardService } from '../brand/brand-rule-guard.service';

function buildService(piece: any, overrides?: { ruleViolations?: any[] }) {
  const contentPieceFindFirst = jest.fn().mockResolvedValue(piece);
  const contentVersionCreate = jest.fn().mockResolvedValue({ id: 'version-2' });
  const contentPieceUpdate = jest.fn().mockResolvedValue({ id: piece.id });

  const prisma = {
    contentPiece: { findFirst: contentPieceFindFirst, update: contentPieceUpdate },
    contentVersion: { create: contentVersionCreate },
  } as unknown as PrismaService;

  const recordObservation = jest.fn().mockResolvedValue({});
  const brandLearning = { recordObservation } as unknown as BrandLearningService;

  const checkText = jest.fn().mockResolvedValue(overrides?.ruleViolations ?? []);
  const brandRuleGuard = { checkText } as unknown as BrandRuleGuardService;

  const service = new ContentStudioService(prisma, brandLearning, brandRuleGuard);
  return { service, contentVersionCreate, recordObservation, checkText };
}

const basePiece = {
  id: 'piece-1',
  organizationId: 'org-1',
  campaignId: 'campaign-1',
  channel: 'googleads',
  currentVersion: { body: 'ancien contenu', assetId: null, createdByUserId: null },
  versions: [{ versionNumber: 1, label: null }],
};

// Vérifie la correction du gap identifié dans le README (item 62) : la génération IA
// applique déjà les limites 30/90 caractères Google Ads, mais rien ne protégeait une
// édition manuelle via editContent() avant ce correctif.
describe('ContentStudioService.editContent — validation Google Ads', () => {
  it('rejette une édition qui dépasse les limites de caractères', async () => {
    const { service, contentVersionCreate } = buildService(basePiece);
    const oversizedBody = 'Titres (30 caractères max) :\n1. ' + 'x'.repeat(35) + '\n\nDescriptions (90 caractères max) :\n1. ok';

    await expect(service.editContent('org-1', 'piece-1', { body: oversizedBody })).rejects.toThrow(BadRequestException);
    expect(contentVersionCreate).not.toHaveBeenCalled();
  });

  it('accepte une édition qui respecte les limites', async () => {
    const { service, contentVersionCreate } = buildService(basePiece);
    const validBody = 'Titres (30 caractères max) :\n1. Titre court\n\nDescriptions (90 caractères max) :\n1. Description correcte.';

    await service.editContent('org-1', 'piece-1', { body: validBody });
    expect(contentVersionCreate).toHaveBeenCalled();
  });

  it('ne valide jamais les limites Google Ads sur un contenu d\'un autre canal', async () => {
    const instagramPiece = { ...basePiece, channel: 'instagram' };
    const { service, contentVersionCreate } = buildService(instagramPiece);

    // Format qui violerait les limites Google Ads s'il était interprété comme tel — doit
    // passer sans encombre puisque ce n'est pas un canal Google Ads.
    const body = 'Titres (30 caractères max) :\n1. ' + 'x'.repeat(50);
    await service.editContent('org-1', 'piece-1', { body });
    expect(contentVersionCreate).toHaveBeenCalled();
  });
});

// Brand Brain (Phase 11) : une RULE active dont metadata.forbiddenTerms est renseigné doit
// être appliquée par du code, jamais laissée à la seule discipline du prompt — vérifié ici
// sur le seul point d'édition manuelle existant (jamais passé par l'IA).
describe('ContentStudioService.editContent — application des règles de marque (Phase 11)', () => {
  it('refuse une édition qui contient un terme explicitement interdit par une règle active', async () => {
    const { service, contentVersionCreate } = buildService(basePiece, {
      ruleViolations: [{ ruleId: 'rule-1', ruleContent: 'Ne jamais promettre un résultat garanti', matchedTerm: 'garanti' }],
    });

    await expect(service.editContent('org-1', 'piece-1', { body: 'Résultat garanti sous 30 jours.' })).rejects.toThrow(BadRequestException);
    expect(contentVersionCreate).not.toHaveBeenCalled();
  });

  it("accepte l'édition quand aucune règle n'est enfreinte", async () => {
    const { service, contentVersionCreate, checkText } = buildService(basePiece, { ruleViolations: [] });

    await service.editContent('org-1', 'piece-1', {
      body: 'Titres (30 caractères max) :\n1. Titre correct\n\nDescriptions (90 caractères max) :\n1. Description correcte.',
    });

    expect(checkText).toHaveBeenCalled();
    expect(contentVersionCreate).toHaveBeenCalled();
  });
});

// Brand Brain (Phase 4) : capture la différence entre la version générée par l'IA et la
// version approuvée par l'humain, jamais l'inverse — cf. gap identifié à l'audit du
// 2026-08-12 (Content Studio capturait changeNote en texte libre, jamais le diff réel).
describe('ContentStudioService.editContent — capture Brand Brain des éditions humaines', () => {
  const aiPiece = {
    id: 'piece-1',
    organizationId: 'org-1',
    campaignId: 'campaign-1',
    channel: 'instagram',
    currentVersion: { body: 'Découvrez notre solution révolutionnaire.', assetId: null, createdByUserId: null },
    versions: [{ versionNumber: 1, label: null }],
  };

  it('enregistre une observation par mot retiré lors de la première édition humaine sur une version IA', async () => {
    const { service, recordObservation } = buildService(aiPiece);

    await service.editContent('org-1', 'piece-1', { body: 'Découvrez notre solution.' });

    expect(recordObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        dedupKey: 'edit-removed:instagram:revolutionnaire',
        source: 'content_studio_edit',
        sourceId: 'piece-1',
        sourceCampaignId: 'campaign-1',
      }),
    );
  });

  it("n'enregistre rien quand la version précédente était déjà une édition humaine", async () => {
    const alreadyEditedPiece = { ...aiPiece, currentVersion: { ...aiPiece.currentVersion, createdByUserId: 'user-1' } };
    const { service, recordObservation } = buildService(alreadyEditedPiece);

    await service.editContent('org-1', 'piece-1', { body: 'Encore un changement.' });

    expect(recordObservation).not.toHaveBeenCalled();
  });

  it("n'enregistre rien quand le texte n'a pas changé", async () => {
    const { service, recordObservation } = buildService(aiPiece);

    await service.editContent('org-1', 'piece-1', { body: aiPiece.currentVersion.body });

    expect(recordObservation).not.toHaveBeenCalled();
  });

  it("n'échoue jamais l'édition si la capture Brand Brain échoue (best-effort)", async () => {
    const { service, recordObservation, contentVersionCreate } = buildService(aiPiece);
    recordObservation.mockRejectedValue(new Error('base indisponible'));

    await expect(service.editContent('org-1', 'piece-1', { body: 'Découvrez notre solution.' })).resolves.toBeDefined();
    expect(contentVersionCreate).toHaveBeenCalled();
  });
});
