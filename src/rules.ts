import type { BLOCK_KINDS, DraftState, Stage } from "./db/schema";
import { isRedditRef, isThreadsRef, normalizeThreadsHandle, normalizeDomain, normalizeGithub, nameKey, normalizeLinkedin, normalizeName, normalizeRedditUser, normalizeXHandle } from "./normalize";

/** Progress order. lost / do_not_contact are terminal and ranked separately. */
const ORDER: Stage[] = ["new", "qualified", "drafted", "contacted", "connection_pending", "connected", "responded", "call_booked", "pilot", "paying"];
export const rank = (s: Stage) => (s === "lost" ? -1 : s === "do_not_contact" ? 100 : ORDER.indexOf(s));
export const isTerminal = (s: Stage) => s === "lost" || s === "do_not_contact";

/** Only ever move forward; do_not_contact is sticky; lost can be revived by real progress. */
export function advance(current: Stage, next: Stage): Stage {
  if (current === "do_not_contact") return current;
  if (next === "do_not_contact") return next;
  if (next === "lost") return current === "new" || current === "lost" ? "lost" : current;
  if (current === "lost") return next;
  return rank(next) > rank(current) ? next : current;
}

/** Overall stage from the current overall + all channel stages (never moves backwards). */
export function rollup(current: Stage, channelStages: Stage[]): Stage {
  if (current === "do_not_contact" || channelStages.includes("do_not_contact")) return "do_not_contact";
  const live = channelStages.filter((s) => s !== "lost");
  if (channelStages.length && !live.length && rank(current) < rank("call_booked")) return "lost";
  return live.reduce<Stage>((acc, s) => (rank(s) > rank(acc) ? s : acc), current === "lost" && live.length ? "new" : current);
}

export const DRAFT_TRANSITIONS: Record<DraftState, DraftState[]> = {
  drafted: ["drafted", "approved", "discarded"],
  approved: ["drafted", "sent", "discarded"],
  sent: [],
  discarded: [],
};

// ---------- competitor blocklist
export type BlockKind = (typeof BLOCK_KINDS)[number];

export function normalizeHandle(v: string): string {
  if (isThreadsRef(v)) return normalizeThreadsHandle(v) ?? v.trim().toLowerCase();
  if (isRedditRef(v)) return normalizeRedditUser(v.replace(/^@/, "")) ?? v.trim().toLowerCase();
  return normalizeXHandle(v) ?? normalizeGithub(v) ?? normalizeRedditUser(v) ?? (normalizeLinkedin(v)?.split("/").pop() || v.trim().replace(/^@/, "").toLowerCase());
}

export function normalizeBlockValue(kind: BlockKind | undefined, raw: string): { kind: BlockKind; value: string } | null {
  const v = raw.trim();
  if (!v) return null;
  const k: BlockKind = kind ?? (v.startsWith("@") || isRedditRef(v) || /^(https?:\/\/)?(www\.)?(x|twitter|github|reddit|linkedin)\.com\//i.test(v) ? "handle" : /^[^\s@]+\.[a-z]{2,}(\/.*)?$/i.test(v.replace(/^https?:\/\//, "")) ? "domain" : "name");
  const value = k === "domain" ? normalizeDomain(v) : k === "handle" ? normalizeHandle(v) : nameKey(v);
  return value ? { kind: k, value } : null;
}

export interface Probe {
  personNames: string[];
  companyNames: string[];
  handles: string[];
  domains: string[];
}
export interface BlockEntry {
  id: string;
  kind: BlockKind;
  value: string;
  label: string | null;
  displayName?: string | null;
  match?: MatchMode | null;
}
export type MatchMode = "exact" | "fuzzy";

/** Single short words (<=7 chars) (Station, Coral, Axis...) are too generic to match fuzzily. */
export function defaultMatchMode(kind: BlockKind, value: string, raw: string = value): MatchMode {
  return kind === "name" && /^[a-z0-9]{1,7}$/.test(value) && /^[A-Za-z0-9]{1,7}$/.test(raw.trim()) ? "exact" : "fuzzy";
}

const keyed = (xs: string[]) => xs.map((x) => ({ full: nameKey(x), stripped: normalizeName(x) })).filter((x) => x.full);

/**
 * Name entries store the full normalized key (suffixes kept). Matching:
 * - exact: a person OR company name equal to the entry, either as full keys or after legal-suffix stripping
 *   on both sides (Station == "Station Labs Ltd"; "John Station" never matches).
 * - fuzzy: exact rule above, plus the entry's FULL key appearing as whole words inside a company name
 *   ("concord ai" matches "Concord AI Platform", never "Concord Health"). Never broader than the full name.
 * Handles match exactly; domains match incl. subdomains.
 */
export function matchBlocklist(entries: BlockEntry[], p: Probe) {
  const persons = keyed(p.personNames);
  const companies = keyed(p.companyNames);
  const handles = p.handles.map((h) => h.toLowerCase()).filter(Boolean);
  const domains = p.domains.map((d) => normalizeDomain(d)).filter((d): d is string => !!d);
  const hits: { entry: BlockEntry; matched_on: string }[] = [];
  for (const e of entries) {
    let on: string | undefined;
    if (e.kind === "domain") on = domains.find((d) => d === e.value || d.endsWith(`.${e.value}`));
    else if (e.kind === "handle") on = handles.find((h) => h === e.value);
    else {
      const full = nameKey(e.value);
      const stripped = normalizeName(e.value);
      const eq = (x: { full: string; stripped: string }) => x.full === full || (!!stripped && x.stripped === stripped);
      const hit = persons.find(eq) ?? companies.find(eq) ??
        ((e.match ?? defaultMatchMode(e.kind, e.value)) === "fuzzy" ? companies.find((c) => ` ${c.full} `.includes(` ${full} `)) : undefined);
      on = hit?.full;
    }
    if (on) hits.push({ entry: e, matched_on: `${e.kind}:${on}` });
  }
  return hits;
}
