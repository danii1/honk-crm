/**
 * Pipeline stages and their lifecycle groups are the single source of truth for both
 * the server schema and the client UI.
 */
export const STAGES = [
  "new", "qualified", "drafted", "contacted", "connection_pending", "connected",
  "responded", "call_booked", "pilot", "paying", "lost", "do_not_contact",
] as const;
export type Stage = (typeof STAGES)[number];

/**
 * Lifecycle is derived from the pipeline stage; it is not a second source of truth.
 * Leads are still being prospected. Contacts are people we have a relationship with
 * (they replied or moved further). Lost / do_not_contact are archived for both.
 */
export const LEAD_STAGES = ["new", "qualified", "drafted", "contacted", "connection_pending", "connected"] as const;
export const CONTACT_STAGES = ["responded", "call_booked", "pilot", "paying"] as const;
export const ARCHIVED_STAGES = ["lost", "do_not_contact"] as const;

export type Lifecycle = "lead" | "contact" | "archived";
export const LIFECYCLES = ["lead", "contact", "archived"] as const;

const LEAD = new Set<string>(LEAD_STAGES);
const CONTACT = new Set<string>(CONTACT_STAGES);
const ARCHIVED = new Set<string>(ARCHIVED_STAGES);

/** Unknown stages are treated as leads so new pipeline stages stay visible. */
export function lifecycleOf(stage: string | null | undefined): Lifecycle {
  if (!stage) return "lead";
  if (CONTACT.has(stage)) return "contact";
  if (ARCHIVED.has(stage)) return "archived";
  return LEAD.has(stage) ? "lead" : "lead";
}

export function stagesForLifecycle(lifecycle: Lifecycle): Stage[] {
  if (lifecycle === "contact") return [...CONTACT_STAGES];
  if (lifecycle === "archived") return [...ARCHIVED_STAGES];
  return [...LEAD_STAGES];
}

export function isLeadStage(stage: string | null | undefined) {
  return lifecycleOf(stage) === "lead";
}

export function isContactStage(stage: string | null | undefined) {
  return lifecycleOf(stage) === "contact";
}

export function isArchivedStage(stage: string | null | undefined) {
  return lifecycleOf(stage) === "archived";
}

export const LIFECYCLE_LABELS: Record<Lifecycle, string> = {
  lead: "Lead",
  contact: "Contact",
  archived: "Archived",
};

export function lifecycleCounts(stages: Record<string, number>) {
  const counts = { lead: 0, contact: 0, archived: 0, total: 0 };
  for (const [stage, n] of Object.entries(stages)) {
    counts[lifecycleOf(stage)] += n;
    counts.total += n;
  }
  return counts;
}
