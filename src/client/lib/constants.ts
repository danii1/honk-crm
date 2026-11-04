import { STAGES } from "../../lifecycle";

export { STAGES };
export { LEAD_STAGES, CONTACT_STAGES, ARCHIVED_STAGES } from "../../lifecycle";

/** Sums stage counts for one lifecycle (or every stage when no group is given). */
export function stageCount(stages: Record<string, number>, group: readonly string[] = STAGES) {
  return group.reduce((total, stage) => total + (stages[stage] ?? 0), 0);
}
