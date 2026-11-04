import type { Lifecycle } from "./api";
import { ARCHIVED_STAGES, CONTACT_STAGES, LEAD_STAGES } from "./constants";

/** The list view is URL-driven: /contacts defaults to relationships, ?view=archived opens Lost / DNC. */
export function viewFromParams(lifecycle: "lead" | "contact", params: URLSearchParams): Lifecycle {
  if (lifecycle === "lead") return "lead";
  return params.get("view") === "archived" ? "archived" : "contact";
}

export function stagesForView(view: Lifecycle): readonly string[] {
  if (view === "lead") return LEAD_STAGES;
  if (view === "contact") return CONTACT_STAGES;
  return ARCHIVED_STAGES;
}

/** A stage belongs to at most one lifecycle; drop stale values that do not fit the current view. */
export function stageForView(view: Lifecycle, stage: string | null): string | undefined {
  if (!stage) return undefined;
  return stagesForView(view).includes(stage) ? stage : undefined;
}

/** Updates the URL for a tab change and clears a stage that belongs to the previous lifecycle. */
export function paramsForView(params: URLSearchParams, view: Lifecycle): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete("offset");
  if (view === "archived") next.set("view", "archived");
  else next.delete("view");
  if (!stageForView(view, next.get("stage"))) next.delete("stage");
  return next;
}

/**
 * Filters for list_contacts_view. A stage means the stage on the selected channel when a
 * channel filter is active (matching the server-rendered dashboard), so it must be sent as
 * channel_stage rather than the contact's overall stage.
 */
export function contactListFilters(view: Lifecycle, params: URLSearchParams) {
  const channel = params.get("channel") || undefined;
  const stage = stageForView(view, params.get("stage"));
  return {
    lifecycle: view,
    channel,
    channel_stage: channel ? stage : undefined,
    stage: channel ? undefined : stage,
    source: params.get("source") || undefined,
    campaign_id: params.get("campaign") || undefined,
    query: params.get("query") || undefined,
  };
}
