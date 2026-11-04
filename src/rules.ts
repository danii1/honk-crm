import type { BLOCK_KINDS, DraftState, Stage } from "./db/schema";
import { normalizeDomain, normalizeGithub, normalizeLinkedin, normalizeName, normalizeRedditUser, normalizeXHandle } from "./normalize";

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
  return normalizeXHandle(v) ?? normalizeGithub(v) ?? normalizeRedditUser(v) ?? (normalizeLinkedin(v)?.split("/").pop() || v.trim().replace(/^@/, "").toLowerCase());
}

export function normalizeBlockValue(kind: BlockKind | undefined, raw: string): { kind: BlockKind; value: string } | null {
  const v = raw.trim();
  if (!v) return null;
  const k: BlockKind = kind ?? (v.startsWith("@") || /^(https?:\/\/)?(www\.)?(x|twitter|github|reddit|linkedin)\.com\//i.test(v) ? "handle" : /^[^\s@]+\.[a-z]{2,}(\/.*)?$/i.test(v.replace(/^https?:\/\//, "")) ? "domain" : "name");
  const value = k === "domain" ? normalizeDomain(v) : k === "handle" ? normalizeHandle(v) : normalizeName(v);
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
}

/** Person names must match exactly; company names match on whole words; domains match incl. subdomains. */
export function matchBlocklist(entries: BlockEntry[], p: Probe) {
  const persons = p.personNames.map(normalizeName).filter(Boolean);
  const companies = p.companyNames.map(normalizeName).filter(Boolean);
  const handles = p.handles.map((h) => h.toLowerCase()).filter(Boolean);
  const domains = p.domains.map((d) => normalizeDomain(d)).filter((d): d is string => !!d);
  const hits: { entry: BlockEntry; matched_on: string }[] = [];
  for (const e of entries) {
    let on: string | undefined;
    if (e.kind === "domain") on = domains.find((d) => d === e.value || d.endsWith(`.${e.value}`));
    else if (e.kind === "handle") on = handles.find((h) => h === e.value);
    else on = persons.find((n) => n === e.value) ?? companies.find((c) => c === e.value || ` ${c} `.includes(` ${e.value} `));
    if (on) hits.push({ entry: e, matched_on: `${e.kind}:${on}` });
  }
  return hits;
}
