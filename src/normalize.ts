const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com",
  "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com", "gmx.com", "yandex.ru", "mail.ru",
]);

export function normalizeEmail(email?: string | null): string | null {
  const e = email?.trim().toLowerCase();
  return e && e.includes("@") ? e : null;
}

export function normalizeDomain(input?: string | null): string | null {
  let d = input?.trim().toLowerCase();
  if (!d) return null;
  if (d.includes("@")) d = d.split("@").pop()!;
  d = d.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0]!.split(":")[0]!.replace(/^www\./, "").replace(/\.$/, "");
  return d.includes(".") ? d : null;
}

/** Company domain implied by a work email; null for free-mail providers. */
export function companyDomainFromEmail(email: string | null): string | null {
  const d = normalizeDomain(email);
  return d && !FREE_MAIL.has(d) ? d : null;
}

export function normalizeUrl(url?: string | null): string | null {
  const u = url?.trim().toLowerCase();
  if (!u) return null;
  return u.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
}

const bare = (u: string) => u.trim().replace(/^https?:\/\//i, "").replace(/^(www|m|mobile|old|new|[a-z]{2})\./i, "").split(/[?#]/)[0]!.replace(/\/+$/, "");

/** linkedin.com/in/<slug> (or /company/<slug>); bare slugs are treated as /in/. */
export function normalizeLinkedin(input?: string | null): string | null {
  if (!input?.trim()) return null;
  const b = bare(input).toLowerCase();
  const m = b.match(/^linkedin\.com\/(in|company|pub)\/([^/]+)/);
  if (m) return `linkedin.com/${m[1] === "pub" ? "in" : m[1]}/${decodeURIComponent(m[2]!)}`;
  if (/^[a-z0-9-_%]+$/.test(b)) return `linkedin.com/in/${b}`;
  return null;
}

export function normalizeXHandle(input?: string | null): string | null {
  if (!input?.trim()) return null;
  const b = bare(input);
  const m = b.match(/^(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:\/|$)/i);
  const h = m ? m[1]! : b.replace(/^@/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(h) && !["home", "i", "intent", "search", "share"].includes(h.toLowerCase()) ? h.toLowerCase() : null;
}

export function normalizeRedditUser(input?: string | null): string | null {
  if (!input?.trim()) return null;
  const b = bare(input);
  const m = b.match(/^reddit\.com\/(?:u|user)\/([A-Za-z0-9_-]{3,20})/i);
  const h = m ? m[1]! : b.replace(/^\/?u\//i, "");
  return /^[A-Za-z0-9_-]{3,20}$/.test(h) ? h.toLowerCase() : null;
}

export function normalizeGithub(input?: string | null): string | null {
  if (!input?.trim()) return null;
  const b = bare(input);
  const m = b.match(/^github\.com\/([A-Za-z0-9-]{1,39})(?:\/|$)/i);
  const h = m ? m[1]! : b.replace(/^@/, "");
  return /^[A-Za-z0-9-]{1,39}$/.test(h) && !["orgs", "sponsors", "topics", "features"].includes(h.toLowerCase()) ? h.toLowerCase() : null;
}

/** Lowercase, strip accents/punctuation and legal suffixes, collapse spaces. */
export function normalizeName(input?: string | null): string {
  return (input ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(inc|llc|ltd|gmbh|corp|co|hq|io|ai|labs?)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** Fuzzy equality for person/company names: same tokens, or small edit distance. */
export function similarNames(a?: string | null, b?: string | null): boolean {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const tx = new Set(x.split(" "));
  const ty = new Set(y.split(" "));
  const inter = [...tx].filter((t) => ty.has(t)).length;
  if (inter / Math.min(tx.size, ty.size) >= 1 && inter >= Math.min(2, tx.size, ty.size)) return true;
  return levenshtein(x, y) <= Math.max(1, Math.floor(Math.min(x.length, y.length) / 6));
}

/** Start of the next local day (exclusive end of "today") in an IANA zone. */
export function endOfLocalDay(now: Date, tz: string): Date {
  return new Date(startOfLocalDay(now, tz).getTime() + 86_400_000);
}
export function startOfLocalDay(now: Date, tz: string): Date {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  const offset = asUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(+p.year!, +p.month! - 1, +p.day!) - offset);
}
export function localDateString(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export async function sha256(value: unknown): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(value));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
