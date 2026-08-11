import { BadRequestException } from '@nestjs/common';
import { ContentStudioService } from './content-studio.service';
import { PrismaService } from '../prisma/prisma.service';

function buildService(piece: any) {
  const contentPieceFindFirst = jest.fn().mockResolvedValue(piece);
  const contentVersionCreate = jest.fn().mockResolvedValue({ id: 'version-2' });
  const contentPieceUpdate = jest.fn().mockResolvedValue({ id: piece.id });

  const prisma = {
    contentPiece: { findFirst: contentPieceFindFirst, update: contentPieceUpdate },
    contentVersion: { create: contentVersionCreate },
  } as unknown as PrismaService;

  const service = new ContentStudioService(prisma);
  return { service, contentVersionCreate };
}

const basePiece = {
  id: 'piece-1',
  organizationId: 'org-1',
  channel: 'googleads',
  currentVersion: { body: 'ancien contenu', assetId: null },
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
