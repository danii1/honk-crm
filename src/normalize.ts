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

export async function sha256(value: unknown): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(value));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
