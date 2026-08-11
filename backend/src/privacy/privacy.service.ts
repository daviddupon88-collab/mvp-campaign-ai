import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { getLegalDocument, listLegalDocuments, getCurrentPolicyVersion } from './legal-documents';

// Opérationnalise les obligations RGPD (portabilité Article 20, effacement Article 17) et
// AI Act (information sur l'usage de systèmes d'IA) — au-delà des textes légaux statiques
// dans legal-documents.ts, ce service fournit les mécanismes RÉELS que ces textes promettent.
@Injectable()
export class PrivacyService {
  constructor(private readonly prisma: PrismaService) {}

  // Portabilité (RGPD Article 20) : compile toutes les données personnelles et
  // organisationnelles de l'utilisateur en un objet structuré exportable. Volontairement
  // exhaustif plutôt que minimal — mieux vaut exporter une donnée non strictement
  // "personnelle" par excès de prudence qu'omettre une donnée qui aurait dû l'être.
  async exportUserData(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberships: { include: { organization: true } },
        notifications: true,
        supportTickets: { include: { replies: true } },
        policyAcceptances: true,
      },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable');

    // Pour chaque organisation dont l'utilisateur est membre, inclut les données de contenu
    // qu'il a personnellement créées (traçées via createdByUserId) — pas l'intégralité des
    // données de l'organisation, qui appartiennent collectivement à l'équipe, pas à cet individu.
    const createdContentVersions = await this.prisma.contentVersion.findMany({
      where: { createdByUserId: userId },
      select: { id: true, body: true, createdAt: true, contentPieceId: true },
    });

    return {
      exportedAt: new Date().toISOString(),
      format: 'campaign-ai-gdpr-export-v1',
      account: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        createdAt: user.createdAt,
      },
      organizations: user.memberships.map((m) => ({
        id: m.organization.id,
        name: m.organization.name,
        role: m.role,
        joinedAt: m.createdAt,
      })),
      notifications: user.notifications,
      supportTickets: user.supportTickets,
      policyAcceptances: user.policyAcceptances,
      contentCreated: createdContentVersions,
    };
  }

  // Effacement (RGPD Article 17) : suppression DOUCE — anonymise les champs identifiants
  // plutôt qu'un DELETE SQL, car des tables légalement obligées de survivre (factures via
  // Stripe, AuditLog pour la sécurité) référencent cet utilisateur. La ligne User persiste
  // avec deletedAt renseigné et des champs vidés/randomisés — le compte devient inutilisable
  // (email non réutilisable pour se reconnecter) sans casser l'intégrité référentielle.
  //
  // GARDE-FOU : refuse si l'utilisateur est le dernier OWNER d'une organisation avec d'autres
  // membres — une organisation ne doit jamais se retrouver sans propriétaire du jour au
  // lendemain à cause d'une demande d'effacement individuelle.
  async requestAccountDeletion(userId: string): Promise<{ status: string }> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      include: { organization: { include: { users: true } } },
    });

    for (const membership of memberships) {
      if (membership.role === 'OWNER' && membership.organization.users.length > 1) {
        throw new BadRequestException(
          `Impossible de supprimer ce compte : il est propriétaire de l'organisation "${membership.organization.name}", qui compte d'autres membres. Transférez la propriété avant de continuer.`,
        );
      }
    }

    const anonymizedEmail = `deleted-user-${userId}@deleted.campaign-ai.invalid`;

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          email: anonymizedEmail,
          fullName: null,
          passwordHash: 'deleted', // hash invalide — aucun mot de passe ne peut jamais correspondre
          deletedAt: new Date(),
        },
      }),
      // Retire l'utilisateur de toutes ses organisations — un compte supprimé ne doit plus
      // apparaître dans les listes de membres ni compter dans les quotas de sièges.
      this.prisma.membership.deleteMany({ where: { userId } }),
    ]);

    return { status: 'deleted' };
  }

  // AI Act : information explicite sur l'usage de systèmes d'IA pour une campagne donnée —
  // reconstruite à partir de la traçabilité déjà existante (AiGeneration) plutôt que
  // maintenue séparément, pour ne jamais désynchroniser la déclaration de la réalité.
  async getAiDisclosureForCampaign(organizationId: string, campaignId: string) {
    const campaign = await this.prisma.campaign.findFirst({ where: { id: campaignId, organizationId } });
    if (!campaign) throw new NotFoundException('Campagne introuvable');

    const generations = await this.prisma.aiGeneration.findMany({
      where: { organizationId, campaignId, status: 'SUCCEEDED' },
      select: { taskType: true, provider: true, model: true, purpose: true, createdAt: true },
    });

    const providers = [...new Set(generations.map((g) => g.provider))];
    const humanReviewed = campaign.status === 'APPROVED' || campaign.status === 'PUBLISHED';

    return {
      campaignId,
      aiGenerated: generations.length > 0,
      providersUsed: providers,
      generationCount: generations.length,
      humanReviewRequired: true, // invariant de la plateforme — jamais contournable, cf. garde-fous
      humanReviewCompleted: humanReviewed,
      approvedByEmail: campaign.approvedByEmail,
      approvedAt: campaign.approvedAt,
      moderationVerdict: campaign.moderationVerdict,
      disclosureText: getLegalDocument('AI_DISCLOSURE').body,
    };
  }

  listPolicies() {
    return listLegalDocuments();
  }

  getPolicy(type: string) {
    return getLegalDocument(type);
  }

  async acceptPolicy(userId: string, policyType: string, ipAddress?: string) {
    return this.prisma.policyAcceptance.create({
      data: { userId, policyType: policyType as any, version: getCurrentPolicyVersion(), ipAddress },
    });
  }

  // Vérifie si l'utilisateur a accepté la version EN VIGUEUR de chaque politique requise —
  // une acceptation d'une version antérieure ne compte pas, cf. commentaire dans legal-documents.ts.
  async getAcceptanceStatus(userId: string) {
    const acceptances = await this.prisma.policyAcceptance.findMany({ where: { userId } });
    const currentVersion = getCurrentPolicyVersion();

    return listLegalDocuments().map((doc) => ({
      type: doc.type,
      currentVersion,
      accepted: acceptances.some((a) => a.policyType === doc.type && a.version === currentVersion),
    }));
  }
}
