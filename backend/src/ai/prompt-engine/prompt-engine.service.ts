import { Injectable } from '@nestjs/common';
import { PromptTask } from './prompt-task.enum';
import { PromptTemplate } from './prompt-engine.types';
import { productAnalysisTemplate, ProductAnalysisContext } from './templates/product-analysis.template';
import { productIdentificationTemplate, ProductIdentificationContext } from './templates/product-identification.template';
import { creativeBriefTemplate, CreativeBriefContext } from './templates/creative-brief.template';
import { videoConceptTemplate, VideoConceptContext } from './templates/video-concept.template';
import { videoJudgeTemplate, VideoJudgeContext } from './templates/video-judge.template';
import { repairTemplate, RepairContext } from './templates/repair.template';
import { creativeVariationTemplate, CreativeVariationContext } from './templates/creative-variation.template';
import { creativeGateTemplate, CreativeGateContext } from './templates/creative-gate.template';
import { storyboardGateTemplate, StoryboardGateContext } from './templates/storyboard-gate.template';

// P0.5 — Prompt Engine V2. Registre de templates typés par tâche (PromptTask), chacun assemblant
// role/mission/constraints/outputSchema en un prompt final via render(context). Portée assumée
// (cf. prompt-task.enum.ts) : seules les tâches listées ci-dessous sont enregistrées — appeler
// render() pour une tâche non enregistrée lève une erreur explicite plutôt que de renvoyer un
// prompt vide silencieusement (jamais un faux succès).
@Injectable()
export class PromptEngineService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly templates = new Map<PromptTask, PromptTemplate<any>>([
    [PromptTask.PRODUCT_ANALYSIS, productAnalysisTemplate],
    [PromptTask.PRODUCT_IDENTIFICATION, productIdentificationTemplate],
    [PromptTask.CREATIVE_BRIEF, creativeBriefTemplate],
    [PromptTask.VIDEO_CONCEPT, videoConceptTemplate],
    [PromptTask.VIDEO_JUDGE, videoJudgeTemplate],
    [PromptTask.REPAIR, repairTemplate],
    [PromptTask.CREATIVE_VARIATION, creativeVariationTemplate],
    [PromptTask.CREATIVE_GATE, creativeGateTemplate],
    [PromptTask.STORYBOARD_GATE, storyboardGateTemplate],
  ]);

  render(task: PromptTask.PRODUCT_ANALYSIS, context: ProductAnalysisContext): string;
  render(task: PromptTask.PRODUCT_IDENTIFICATION, context: ProductIdentificationContext): string;
  render(task: PromptTask.CREATIVE_BRIEF, context: CreativeBriefContext): string;
  render(task: PromptTask.VIDEO_CONCEPT, context: VideoConceptContext): string;
  render(task: PromptTask.VIDEO_JUDGE, context: VideoJudgeContext): string;
  render(task: PromptTask.REPAIR, context: RepairContext): string;
  render(task: PromptTask.CREATIVE_VARIATION, context: CreativeVariationContext): string;
  render(task: PromptTask.CREATIVE_GATE, context: CreativeGateContext): string;
  render(task: PromptTask.STORYBOARD_GATE, context: StoryboardGateContext): string;
  render(task: PromptTask, context: unknown): string {
    const template = this.templates.get(task);
    if (!template) {
      throw new Error(`PromptEngineService: aucun template enregistré pour la tâche "${task}" — cf. prompt-task.enum.ts pour la portée assumée de ce chantier.`);
    }
    return template.render(context);
  }

  getTemplate(task: PromptTask): PromptTemplate<unknown> | undefined {
    return this.templates.get(task);
  }
}
