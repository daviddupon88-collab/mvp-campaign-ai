import { CreativeConcept } from '../creative-intelligence/creative-concept.types';

// Mission 4 Phase E ("Creative Video & Audio Intelligence", 2026-08-20) — construit le champ
// `instructions` de gpt-4o-mini-tts à partir de champs DÉJÀ générés par CreativeConceptService,
// jamais un nouveau prompt libre inventé. Fonction PURE (aucune I/O, aucun appel IA) — utilisée
// EXCLUSIVEMENT par le benchmark isolé (mission4-tts-benchmark.ts) tant que l'adoption de ce
// modèle en production n'a pas été validée empiriquement (Correction obligatoire 5, cf. Phase E).
export function buildVoiceDirectionInstructions(concept: Pick<CreativeConcept, 'hook' | 'emotionalDirection' | 'cta'>): string {
  return [
    `Ton et énergie : ${concept.emotionalDirection}.`,
    `Cette narration ouvre sur : "${concept.hook}" — marque une accroche nette dès les premiers mots, jamais un ton plat de lecture.`,
    `Elle se termine par un appel à l'action : "${concept.cta}" — prononcé avec conviction, pas en retrait.`,
  ].join(' ');
}
