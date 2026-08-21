import { Injectable, Logger } from '@nestjs/common';
import { parseAiJson } from '../../common/parsing/parse-ai-json';
import { AiGatewayService, AiCallContext } from '../ai-gateway/ai-gateway.service';
import { PROMPT_VERSIONS } from '../prompt-versions';

// Attributs visuels du produit que CHAQUE plan généré par Veo doit préserver — extraits une
// seule fois par campagne (un appel vision), réutilisés par VideoDirectorService (construction
// du Shot Plan) et VideoAnalyzerService (vérification de fidélité après génération). Sans ce
// contrat explicite, rien ne garantit qu'un plan généré ressemble encore au produit réel après
// plusieurs étapes de génération/régénération.
export interface VisualDna {
  productCategory: string;
  colors: string[];
  materials: string[];
  shape: string;
  distinctiveFeatures: string[];
  logoOrBrandMarks: string | null;
  raw: string; // réponse brute conservée pour debug/repli, même principe que ailleurs dans ce fichier
  // Audit forensique Mission 4.2 (P0-1) : true si les DEUX tentatives d'extraction ont échoué et
  // que cet objet est le repli neutre — un consommateur (VideoAnalyzerService, VideoDirectorService)
  // ne doit JAMAIS traiter un ADN visuel de repli comme une référence réelle du produit. Optionnel
  // (absent = false, comportement historique) pour ne pas casser les fixtures de test existantes.
  isFallback?: boolean;
}

const FALLBACK_VISUAL_DNA: Omit<VisualDna, 'raw'> = {
  productCategory: 'non déterminée',
  colors: [],
  materials: [],
  shape: 'non déterminée',
  distinctiveFeatures: [],
  logoOrBrandMarks: null,
};

// Extraction de l'ADN visuel du produit (couleurs, matières, forme, éléments distinctifs, logo)
// à partir de la VRAIE photo produit — pas du visuel marketing généré par ailleurs (Flux) — cf.
// AiOrchestratorService.generateCampaign() qui décide de la source d'image transmise ici. C'est
// le socle de fidélité de toute l'architecture Shot Plan : sans cet ancrage, Veo (ou son
// évaluateur en aval) n'a aucune référence objective de ce à quoi le produit ressemble vraiment.
@Injectable()
export class VisualDnaService {
  private readonly logger = new Logger(VisualDnaService.name);

  constructor(private readonly aiGateway: AiGatewayService) {}

  async extract(ctx: AiCallContext, imageUrl: string, productDescription?: string): Promise<VisualDna> {
    const descriptionHint = productDescription?.trim() ? `\nDescription fournie : ${productDescription}` : '';
    const prompt = `Observe cette photo de produit et décris précisément son identité visuelle, pour qu'elle puisse être reconnue et préservée dans des vidéos générées séparément.${descriptionHint}
Réponds UNIQUEMENT en JSON strict, sans texte autour, au format exact :
{"productCategory":"...","colors":["...","..."],"materials":["...","..."],"shape":"...","distinctiveFeatures":["...","..."],"logoOrBrandMarks":"..."|null}`;

    // Audit forensique Mission 4.2 (P0-1) : cet appel est le socle de fidélité de toute
    // l'architecture Shot Plan — un simple aléa de formatage ne doit pas suffire à le vider,
    // même discipline de retry unique que le Shot Plan et les critères texte du Video Judge.
    const first = await this.aiGateway.analyzeImage(ctx, { prompt, imageUrl }, 'openai', PROMPT_VERSIONS.visualDna);
    const parsedFirst = this.tryParse(first.content);
    if (parsedFirst) return { ...parsedFirst, raw: first.content, isFallback: false };

    this.logger.warn('Réponse d\'extraction de l\'ADN visuel non conforme au format JSON attendu, nouvel essai avant repli neutre.');
    const second = await this.aiGateway.analyzeImage(ctx, { prompt, imageUrl }, 'openai', PROMPT_VERSIONS.visualDna);
    const parsedSecond = this.tryParse(second.content);
    if (parsedSecond) return { ...parsedSecond, raw: second.content, isFallback: false };

    this.logger.warn("Réponse d'extraction de l'ADN visuel non conforme au format JSON attendu après 2 tentatives, repli neutre conservé (isFallback=true).");
    return { ...FALLBACK_VISUAL_DNA, raw: second.content, isFallback: true };
  }

  private tryParse(raw: string): Omit<VisualDna, 'raw' | 'isFallback'> | null {
    try {
      const parsed = parseAiJson<any>(raw);
      return {
        productCategory: typeof parsed.productCategory === 'string' ? parsed.productCategory : FALLBACK_VISUAL_DNA.productCategory,
        colors: Array.isArray(parsed.colors) ? parsed.colors : FALLBACK_VISUAL_DNA.colors,
        materials: Array.isArray(parsed.materials) ? parsed.materials : FALLBACK_VISUAL_DNA.materials,
        shape: typeof parsed.shape === 'string' ? parsed.shape : FALLBACK_VISUAL_DNA.shape,
        distinctiveFeatures: Array.isArray(parsed.distinctiveFeatures) ? parsed.distinctiveFeatures : FALLBACK_VISUAL_DNA.distinctiveFeatures,
        logoOrBrandMarks: typeof parsed.logoOrBrandMarks === 'string' ? parsed.logoOrBrandMarks : null,
      };
    } catch {
      return null;
    }
  }
}
