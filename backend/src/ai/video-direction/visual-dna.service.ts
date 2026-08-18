import { Injectable, Logger } from '@nestjs/common';
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

    const result = await this.aiGateway.analyzeImage(ctx, { prompt, imageUrl }, 'openai', PROMPT_VERSIONS.visualDna);
    return this.parse(result.content);
  }

  // Même principe de repli que AiOrchestratorService.formatProductAnalysis : un modèle qui ne
  // respecte pas le format JSON demandé ne doit jamais faire échouer la génération de campagne
  // — repli sur des valeurs neutres, `raw` conservé pour qu'un validateur humain (ou un futur
  // debug) puisse voir ce qui a réellement été renvoyé.
  private parse(raw: string): VisualDna {
    try {
      const parsed = JSON.parse(raw);
      return {
        productCategory: typeof parsed.productCategory === 'string' ? parsed.productCategory : FALLBACK_VISUAL_DNA.productCategory,
        colors: Array.isArray(parsed.colors) ? parsed.colors : FALLBACK_VISUAL_DNA.colors,
        materials: Array.isArray(parsed.materials) ? parsed.materials : FALLBACK_VISUAL_DNA.materials,
        shape: typeof parsed.shape === 'string' ? parsed.shape : FALLBACK_VISUAL_DNA.shape,
        distinctiveFeatures: Array.isArray(parsed.distinctiveFeatures) ? parsed.distinctiveFeatures : FALLBACK_VISUAL_DNA.distinctiveFeatures,
        logoOrBrandMarks: typeof parsed.logoOrBrandMarks === 'string' ? parsed.logoOrBrandMarks : null,
        raw,
      };
    } catch (error) {
      this.logger.warn(`Réponse d'extraction de l'ADN visuel non conforme au format JSON attendu, repli neutre conservé: ${error}`);
      return { ...FALLBACK_VISUAL_DNA, raw };
    }
  }
}
