const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api';

// Porte les champs structurés renvoyés par PlanLimitExceededException côté backend
// (code, plan recommandé, plafond atteint) — un `throw new Error(body.message)` classique
// aurait silencieusement perdu ces champs, empêchant tout moment de conversion ciblé.
export class ApiError extends Error {
  code?: string;
  limitType?: string;
  currentPlan?: string;
  recommendedPlan?: string | null;
  current?: number;
  limit?: number;
  statusCode?: number;

  constructor(body: any, fallbackStatus: number) {
    super(body.message ?? `API error (${fallbackStatus})`);
    this.code = body.code;
    this.limitType = body.limitType;
    this.currentPlan = body.currentPlan;
    this.recommendedPlan = body.recommendedPlan;
    this.current = body.current;
    this.limit = body.limit;
    this.statusCode = body.statusCode ?? fallbackStatus;
  }

  get isPlanLimit(): boolean {
    return this.code === 'PLAN_LIMIT_EXCEEDED';
  }
}

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('accessToken');
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(body, response.status);
  }

  return response.json();
}

export const api = {
  register: (data: { email: string; password: string; fullName: string; organizationName: string }) =>
    request<{ accessToken: string }>('/auth/register', { method: 'POST', body: JSON.stringify(data) }),

  login: (data: { email: string; password: string }) =>
    request<{ accessToken: string }>('/auth/login', { method: 'POST', body: JSON.stringify(data) }),

  me: () => request<any>('/auth/me'),

  updateLanguage: (preferredLanguage: string) =>
    request<{ id: string; preferredLanguage: string }>('/auth/language', { method: 'PATCH', body: JSON.stringify({ preferredLanguage }) }),

  listCampaigns: () => request<any[]>('/campaigns'),

  createCampaign: (data: { name: string; productDescription?: string; productImageAssetId?: string; objective: string; budget?: number; channels?: string[]; templateId?: string }) =>
    request<any>('/campaigns', { method: 'POST', body: JSON.stringify(data) }),

  getCampaign: (id: string) => request<any>(`/campaigns/${id}`),
  approveCampaign: (id: string) => request<any>(`/campaigns/${id}/approve`, { method: 'POST' }),
  rejectCampaign: (id: string, reason: string) =>
    request<any>(`/campaigns/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
  regenerateCampaign: (id: string, data: { name: string; productDescription: string; objective: string; budget?: number }) =>
    request<any>(`/campaigns/${id}/regenerate`, { method: 'POST', body: JSON.stringify(data) }),
  publishCampaign: (campaignId: string, targets: Array<{ socialConnectionId: string; contentVersionId?: string }>) =>
    request<any>(`/social/campaigns/${campaignId}/publish`, { method: 'POST', body: JSON.stringify({ targets }) }),

  // --- Templates (Module 18) ---
  listTemplates: (sector?: string) => request<any[]>(`/templates${sector ? `?sector=${sector}` : ''}`),

  // --- Content Studio ---
  listContentPieces: (campaignId: string) => request<any[]>(`/campaigns/${campaignId}/content`),
  editContentPiece: (campaignId: string, pieceId: string, data: { body?: string; changeNote?: string }) =>
    request<any>(`/campaigns/${campaignId}/content/${pieceId}/edit`, { method: 'POST', body: JSON.stringify(data) }),
  createContentVariations: (campaignId: string, pieceId: string, variations: Array<{ label: string; body?: string }>) =>
    request<any>(`/campaigns/${campaignId}/content/${pieceId}/variations`, { method: 'POST', body: JSON.stringify({ variations }) }),
  selectContentVersion: (campaignId: string, pieceId: string, versionId: string) =>
    request<any>(`/campaigns/${campaignId}/content/${pieceId}/select-version`, { method: 'POST', body: JSON.stringify({ versionId }) }),

  // --- Optimizer ---
  listOptimizations: (campaignId: string) => request<any[]>(`/campaigns/${campaignId}/optimizations`),
  listPendingOptimizations: () => request<any[]>('/optimizations/pending'),
  applyOptimization: (id: string) => request<any>(`/optimizations/${id}/apply`, { method: 'POST', body: JSON.stringify({}) }),
  dismissOptimization: (id: string) => request<any>(`/optimizations/${id}/dismiss`, { method: 'POST', body: JSON.stringify({}) }),
  runOptimizerNow: () => request<any>('/optimizer/run', { method: 'POST' }),

  // --- Calendrier éditorial ---
  listCalendarEntries: (from: string, to: string) => request<any[]>(`/calendar?from=${from}&to=${to}`),
  scheduleCalendarEntry: (data: { contentPieceId: string; socialConnectionId: string; scheduledAt: string }) =>
    request<any>('/calendar', { method: 'POST', body: JSON.stringify(data) }),
  rescheduleCalendarEntry: (id: string, scheduledAt: string) =>
    request<any>(`/calendar/${id}/reschedule`, { method: 'PATCH', body: JSON.stringify({ scheduledAt }) }),
  cancelCalendarEntry: (id: string) => request<any>(`/calendar/${id}`, { method: 'DELETE' }),

  // --- Équipe ---
  listTeamMembers: () => request<any[]>('/team/members'),
  listTeamInvitations: () => request<any[]>('/team/invitations'),
  revokeInvitation: (id: string) => request<any>(`/team/invitations/${id}/revoke`, { method: 'POST' }),
  resendInvitation: (id: string) => request<any>(`/team/invitations/${id}/resend`, { method: 'POST' }),
  changeMemberRole: (membershipId: string, role: string) =>
    request<any>(`/team/members/${membershipId}/role`, { method: 'PATCH', body: JSON.stringify({ role }) }),
  removeMember: (membershipId: string) => request<any>(`/team/members/${membershipId}`, { method: 'DELETE' }),

  // --- Administration plateforme (isPlatformAdmin uniquement, cf. PlatformAdminGuard) ---
  adminListOrganizations: (params?: { search?: string; plan?: string; status?: string }) => {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    return request<any>(`/admin/organizations${qs ? `?${qs}` : ''}`);
  },
  adminGetOrganization: (id: string) => request<any>(`/admin/organizations/${id}`),
  adminSuspendOrganization: (id: string, reason: string) =>
    request<any>(`/admin/organizations/${id}/suspend`, { method: 'POST', body: JSON.stringify({ reason }) }),
  adminReactivateOrganization: (id: string) => request<any>(`/admin/organizations/${id}/reactivate`, { method: 'POST' }),
  adminListUsers: (search?: string) => request<any>(`/admin/users${search ? `?search=${search}` : ''}`),
  adminSubscriptionsOverview: () => request<any>('/admin/subscriptions/overview'),
  adminAiCostsOverview: () => request<any>('/admin/ai-costs/overview'),
  adminRecentErrors: () => request<any>('/admin/errors'),
  adminActivityFeed: () => request<any[]>('/admin/activity'),

  // --- Centre d'aide (public en lecture) ---
  listHelpArticles: (category?: string) => request<any[]>(`/help/articles${category ? `?category=${category}` : ''}`),
  searchHelpArticles: (q: string) => request<any[]>(`/help/articles/search?q=${encodeURIComponent(q)}`),
  getHelpArticle: (slug: string) => request<any>(`/help/articles/${slug}`),

  // --- Support ---
  listMyTickets: () => request<any[]>('/support/tickets'),
  createTicket: (data: { subject: string; message: string; priority?: string }) =>
    request<any>('/support/tickets', { method: 'POST', body: JSON.stringify(data) }),
  getTicket: (id: string) => request<any>(`/support/tickets/${id}`),
  replyTicket: (id: string, message: string) =>
    request<any>(`/support/tickets/${id}/reply`, { method: 'POST', body: JSON.stringify({ message }) }),

  // --- Tarification & conversion ---
  // Public — pas de token requis, alimente la landing page et la page de tarifs
  // avant même la création d'un compte.
  listPlans: () => request<any[]>('/plans'),

  getUsage: () => request<any>('/plans/usage'),

  getSubscription: () => request<any>('/billing/subscription'),

  createCheckout: (data: { plan: string; successUrl: string; cancelUrl: string }) =>
    request<{ checkoutUrl: string }>('/billing/checkout', { method: 'POST', body: JSON.stringify(data) }),

  // --- Assets (upload réel vers l'object storage, cf. StorageService) ---
  // Distinct des autres méthodes: FormData plutôt que JSON, pas de header Content-Type
  // explicite (le navigateur le pose lui-même avec la bonne boundary multipart).
  uploadAsset: async (file: File, altText?: string): Promise<any> => {
    const token = getToken();
    const formData = new FormData();
    formData.append('file', file);
    if (altText) formData.append('altText', altText);

    const response = await fetch(`${API_BASE_URL}/assets/upload`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new ApiError(body, response.status);
    }
    return response.json();
  },

  listAssets: (type?: string) => request<any[]>(`/assets${type ? `?type=${type}` : ''}`),
  // Chaque appel interroge un état déjà existant côté backend plutôt que de dupliquer un
  // suivi de progression séparé — la checklist d'onboarding est TOUJOURS le reflet exact
  // de ce qui a réellement été fait, jamais une case à cocher qui pourrait mentir.
  getBrandKit: () => request<any>('/brand-kit'),

  upsertBrandKit: (data: {
    toneOfVoice?: string;
    valueProps?: string[];
    mission?: string;
    vision?: string;
    slogans?: string[];
    competitors?: Array<{ name: string; notes?: string }>;
    personaNotes?: Array<{ name: string; description?: string }>;
    logoUrl?: string;
  }) => request<any>('/brand-kit', { method: 'PUT', body: JSON.stringify(data) }),

  getBrandMemory: (params?: { limit?: number; type?: string; category?: string; channel?: string; persona?: string; status?: string }) => {
    const qs = new URLSearchParams(Object.entries(params ?? {}).filter(([, v]) => v !== undefined) as [string, string][]).toString();
    return request<any[]>(`/brand-kit/memory${qs ? `?${qs}` : ''}`);
  },
  getBrandBrief: () => request<any>('/brand-kit/brief'),
  getBrandRules: () => request<any[]>('/brand-kit/memory/rules'),
  getBrandContradictions: (status?: string) => request<any[]>(`/brand-kit/memory/contradictions${status ? `?status=${status}` : ''}`),
  confirmBrandMemory: (id: string) => request<any>(`/brand-kit/memory/${id}/confirm`, { method: 'POST' }),
  dismissBrandMemory: (id: string) => request<any>(`/brand-kit/memory/${id}/dismiss`, { method: 'POST' }),
  promoteBrandMemoryToRule: (id: string, forbiddenTerms?: string[]) =>
    request<any>(`/brand-kit/memory/${id}/promote-to-rule`, { method: 'POST', body: JSON.stringify({ forbiddenTerms }) }),
  correctBrandMemory: (id: string, data: { content?: string; category?: string; channel?: string; persona?: string }) =>
    request<any>(`/brand-kit/memory/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  resolveBrandContradiction: (id: string, resolution: 'RESOLVED_A' | 'RESOLVED_B' | 'CONTEXT_DEPENDENT') =>
    request<any>(`/brand-kit/contradictions/${id}/resolve`, { method: 'POST', body: JSON.stringify({ resolution }) }),

  // --- Analytics ---
  getAnalyticsOverview: (limit?: number) => request<any[]>(`/analytics/overview${limit ? `?limit=${limit}` : ''}`),
  getCampaignAnalyticsSummary: (campaignId: string) => request<any>(`/campaigns/${campaignId}/analytics/summary`),
  getCampaignAnalyticsChannels: (campaignId: string) => request<any[]>(`/campaigns/${campaignId}/analytics/channels`),
  getCampaignAnalyticsContent: (campaignId: string) => request<any[]>(`/campaigns/${campaignId}/analytics/content`),
  recordConversion: (campaignId: string, data: { count: number; value: number; note?: string }) =>
    request<any>(`/campaigns/${campaignId}/analytics/conversions`, { method: 'POST', body: JSON.stringify(data) }),

  listSocialConnections: () => request<any[]>('/social/connections'),

  inviteTeamMember: (data: { email: string; role: string }) =>
    request<any>('/team/invitations', { method: 'POST', body: JSON.stringify(data) }),

  getMetaCapiConfig: () => request<{ configured: boolean; pixelId: string | null; enabled: boolean }>('/integrations/meta-capi'),
  updateMetaCapiConfig: (data: { pixelId: string; accessToken: string; enabled?: boolean }) =>
    request<{ configured: boolean; pixelId: string | null; enabled: boolean }>('/integrations/meta-capi', { method: 'PUT', body: JSON.stringify(data) }),
};
