import type { STAGES } from "./db/schema";
import { normalizeEmail, normalizeGithub, normalizeLinkedin, normalizeRedditUser, normalizeXHandle } from "./normalize";

type Stage = (typeof STAGES)[number];

/** RFC 4180 parser: quoted fields, escaped quotes, CRLF/LF, newlines inside quotes, BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

export function parseCsvObjects(text: string): { header: string[]; records: Record<string, string>[] } {
  const [head, ...body] = parseCsv(text);
  const header = (head ?? []).map((h) => h.trim().toLowerCase());
  const records = body.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
  return { header, records };
}

const esc = (v: unknown) => {
  const s = v === null || v === undefined ? "" : Array.isArray(v) ? v.join(";") : v instanceof Date ? v.toISOString() : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (header: string[], rows: unknown[][]) => [header, ...rows].map((r) => r.map(esc).join(",")).join("\n") + "\n";

const STATUS_MAP: Record<string, Stage> = {
  new: "new", found: "new", sourced: "new", lead: "new", prospect: "new",
  qualified: "qualified", to_contact: "qualified", todo: "qualified", shortlisted: "qualified", hot: "qualified",
  drafted: "drafted", draft: "drafted", draft_ready: "drafted",
  contacted: "contacted", sent: "contacted", dm_sent: "contacted", dmed: "contacted", messaged: "contacted", emailed: "contacted", replied_to_post: "contacted", commented: "contacted", reached_out: "contacted",
  connection_pending: "connection_pending", connection_sent: "connection_pending", connection_requested: "connection_pending", invited: "connection_pending", pending: "connection_pending", request_sent: "connection_pending",
  connected: "connected", accepted: "connected",
  responded: "responded", replied: "responded", reply: "responded", interested: "responded", in_conversation: "responded",
  call_booked: "call_booked", call: "call_booked", meeting: "call_booked", meeting_booked: "call_booked", demo: "call_booked",
  pilot: "pilot", trial: "pilot", piloting: "pilot",
  paying: "paying", paid: "paying", customer: "paying", won: "paying", closed_won: "paying",
  lost: "lost", not_interested: "lost", rejected: "lost", declined: "lost", no: "lost", closed_lost: "lost", ghosted: "lost",
  do_not_contact: "do_not_contact", dnc: "do_not_contact", unsubscribed: "do_not_contact", blocked: "do_not_contact", opt_out: "do_not_contact",
  competitor: "do_not_contact",
};

/** Maps a free-form status to a stage. Unknown values -> "new" with known=false. */
export function mapStatus(raw: string | undefined): { stage: Stage; known: boolean; competitor: boolean } {
  const k = (raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!k) return { stage: "new", known: true, competitor: false };
  const stage = STATUS_MAP[k];
  return { stage: stage ?? "new", known: !!stage, competitor: k === "competitor" };
}

export interface ExtractedIdentities {
  emails: string[];
  linkedin: string[];
  github: string[];
  reddit: string[];
  x: string[];
  other_urls: string[];
}

function add(arr: string[], v: string | null) {
  if (v && !arr.includes(v)) arr.push(v);
}

/** Pulls emails and profile URLs out of messy free text (notes, bios). */
export function extractIdentities(text: string | undefined | null): ExtractedIdentities {
  const out: ExtractedIdentities = { emails: [], linkedin: [], github: [], reddit: [], x: [], other_urls: [] };
  if (!text) return out;
  for (const m of text.matchAll(/(?<![\w.+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) add(out.emails, normalizeEmail(m[0]));
  const urls = text.matchAll(/(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:linkedin\.com|github\.com|reddit\.com|x\.com|twitter\.com)\/[^\s,;)<>"'\]]+|https?:\/\/[^\s,;)<>"'\]]+/gi);
  for (const m of urls) {
    const u = m[0].replace(/[.:!?]+$/, "");
    const host = u.replace(/^https?:\/\//i, "").toLowerCase();
    if (/^([a-z0-9-]+\.)*linkedin\.com\//.test(host)) add(out.linkedin, normalizeLinkedin(u));
    else if (/^([a-z0-9-]+\.)*github\.com\//.test(host)) add(out.github, normalizeGithub(u));
    else if (/^([a-z0-9-]+\.)*reddit\.com\//.test(host)) add(out.reddit, normalizeRedditUser(u));
    else if (/^([a-z0-9-]+\.)*(x|twitter)\.com\//.test(host)) add(out.x, normalizeXHandle(u));
    else add(out.other_urls, u);
  }
  for (const m of text.matchAll(/(?:^|[\s(])\/?u\/([A-Za-z0-9_-]{3,20})\b/g)) add(out.reddit, normalizeRedditUser(m[1]!));
  return out;
}
