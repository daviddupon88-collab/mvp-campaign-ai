// Mission 4.4 (Product URL Intelligence, Phase B) — forme demandée par le brief, verbatim.
// SafeProductPageFetcherService est la SEULE responsabilité "URL -> HTTP sécurisé -> Page" —
// aucun appel LLM, aucune construction de concept, jamais de QualityTarget ici.
export interface ProductPageFetchResult {
  url: string;
  finalUrl: string;
  statusCode: number;
  contentType: string;
  html?: string;
  retrievedAt: string;
  warnings: string[];
  // Mission 4.5 (Phase 1 — instrumentation) — additif : le brief 4.4 ne mesurait ni la durée
  // réelle du fetch ni le nombre de sauts de redirection, alors qu'ils sont déjà calculables ici
  // sans appel supplémentaire (audit forensic : gap confirmé, rien de comparable n'existait).
  fetchDurationMs: number;
  redirectCount: number;
}
