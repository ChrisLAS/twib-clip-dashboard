export type EditorialScope = "global" | "episode" | "render";
export interface EditorialRule {
  id: string;
  text: string;
  scope: EditorialScope;
  episodeId: string | null;
  renderId: string | null;
  evidenceIds: string[];
}
export interface EditorialEvidence {
  id: string;
  decision: "up" | "down" | "defer" | "clear";
  reason: string;
  scope: EditorialScope;
  episodeId: string | null;
  renderId: string | null;
  createdAt: string;
}
export interface EditorialProposal {
  id: string;
  rule: EditorialRule;
  status: "pending" | "confirmed" | "dismissed";
  createdAt: string;
}
export interface EditorialProfile {
  version: number;
  enabled: boolean;
  rules: EditorialRule[];
  feedback: EditorialEvidence[];
  proposals: EditorialProposal[];
  updatedAt: string | null;
}
export interface EditorialContext {
  profileVersion: number;
  enabled: boolean;
  episodeId: string | null;
  renderId: string | null;
  rules: EditorialRule[];
  evidenceIds: string[];
  contextHash: string;
  changedBecauseFeedback: false;
  reviewExamples: {
    id: string;
    renderId: string;
    episodeId: string;
    decision: string;
    note: string;
    reason: string;
    occurredAt: string;
    isCurrentRender: boolean;
    isCurrentEpisode: boolean;
  }[];
  coverage: {
    reviewCount: number;
    explicitReasonCount: number;
    blankReasonCount: number;
    inferredRules: 0;
    examplesTruncated: boolean;
  };
  lastReceipt: EditorialReceipt | null;
  loadedStatus: "no_receipt" | "reported_loaded";
}
export interface EditorialProfileInput {
  expectedRevision: number;
  idempotencyKey: string;
  action: "replace" | "disable" | "enable" | "undo";
  reason: string;
  scope: EditorialScope;
  rules?: EditorialRule[];
  undoVersion?: number;
}
export interface EditorialFeedbackInput {
  expectedRevision: number;
  idempotencyKey: string;
  action: "record" | "propose" | "confirm" | "dismiss";
  decision: EditorialEvidence["decision"];
  reason: string;
  scope: EditorialScope;
  episodeId?: string | null;
  renderId?: string | null;
  proposalId?: string;
  ruleText?: string;
}
export interface EditorialReceiptInput {
  actor?: "owner" | "assistant";
  idempotencyKey: string;
  contextHash: string;
  profileVersion: number;
  episodeId: string | null;
  renderId?: string | null;
  stage: "research" | "selection" | "cutting" | "rendering";
  usedRuleIds: string[];
  changedBecauseFeedback: boolean;
  evidenceIds: string[];
  explanation: string;
}
export interface EditorialReceipt extends EditorialReceiptInput {
  id: string;
  createdAt: string;
  attestation: "caller_reported";
}
export function projectEditorialRules(
  profile: EditorialProfile,
  episodeId: string | null,
  renderId: string | null,
): EditorialRule[] {
  if (!profile.enabled) return [];
  return profile.rules
    .filter(
      (r) =>
        r.scope === "global" ||
        (r.scope === "episode" && r.episodeId === episodeId) ||
        (r.scope === "render" &&
          r.renderId === renderId &&
          r.episodeId === episodeId),
    )
    .map((r) => ({
      id: r.id,
      text: r.text,
      scope: r.scope,
      episodeId: r.episodeId,
      renderId: r.renderId,
      evidenceIds: [...r.evidenceIds].sort(),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// This canonical projection is also the read-only connector consumer contract.
export function editorialContextValue(
  profile: EditorialProfile,
  episodeId: string | null,
  renderId: string | null,
) {
  const rules = projectEditorialRules(profile, episodeId, renderId);
  return {
    profileVersion: profile.version,
    enabled: profile.enabled,
    episodeId,
    renderId,
    rules,
    evidenceIds: [...new Set(rules.flatMap((r) => r.evidenceIds))].sort(),
    changedBecauseFeedback: false as const,
  };
}
