import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface RuleViolation {
  ruleId: string;
  ruleContent: string;
  matchedTerm: string;
}

// Phase 11 : "une règle de marque critique ne doit pas dépendre uniquement du prompt". Une
// RULE reste un texte libre (ex: "Ne jamais utiliser de promesse de résultat garanti"), donc
// une vérification générique par code nécessiterait une compréhension sémantique — hors de
// portée sans appel IA dédié (cf. limitation similaire assumée pour ContradictionService).
// Ce service applique une vérification RÉELLE mais volontairement ciblée : quand une RULE
// porte des termes interdits explicites (metadata.forbiddenTerms, renseignés à la création ou
// à la promotion d'une connaissance en RULE — cf. Lot E), leur présence est bloquée par du
// code, jamais laissée à la seule discipline du modèle IA dans le prompt.
@Injectable()
export class BrandRuleGuardService {
  constructor(private readonly prisma: PrismaService) {}

  async checkText(organizationId: string, text: string, params?: { channel?: string }): Promise<RuleViolation[]> {
    if (!text) return [];

    const rules = await this.prisma.brandMemoryEntry.findMany({
      where: { organizationId, type: 'RULE', status: 'ACTIVE' },
    });

    const normalizedText = text.toLowerCase();
    const violations: RuleViolation[] = [];

    for (const rule of rules) {
      // Une règle spécifique à un autre canal que celui du contenu vérifié ne s'applique pas
      // ici — une règle GLOBALE (channel absent) s'applique en revanche toujours.
      if (params?.channel && rule.channel && rule.channel !== params.channel) continue;

      const forbiddenTerms = (rule.metadata as { forbiddenTerms?: string[] } | null)?.forbiddenTerms;
      if (!forbiddenTerms?.length) continue;

      for (const term of forbiddenTerms) {
        if (normalizedText.includes(term.toLowerCase())) {
          violations.push({ ruleId: rule.id, ruleContent: rule.content, matchedTerm: term });
        }
      }
    }

    return violations;
  }
}
