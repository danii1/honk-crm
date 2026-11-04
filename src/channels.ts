import { normalizeEmail, normalizeGithub, normalizeLinkedin, normalizeRedditUser, normalizeThreadsHandle, normalizeXHandle } from "./normalize";

/**
 * Config-driven channel + identity registry. Adding a channel = adding an entry here (or an org custom channel row);
 * no DB migration, enums or CHECK constraints involved. Channel/source columns are plain text validated against this.
 */
export interface Identity {
  kind: string;
  value: string; // normalized
  scope: string; // "" when unscoped (discord server, slack workspace, ...)
  raw?: string;
}

export interface IdentityKind {
  kind: string;
  channel: string;
  label: string;
  /** contacts column kept in sync for backward compatibility (legacy args/exports). */
  legacyColumn?: "email" | "linkedin" | "xHandle" | "redditUser" | "github" | "threadsHandle";
  /** Legacy upsert arg name. */
  legacyArg?: string;
  scoped?: boolean;
  private?: boolean;
  normalize: (v: string) => string | null;
  /** Parses a URL (scheme/www stripped, original case) into a value (+ scope). */
  url?: (bare: string) => { value: string; scope?: string } | null;
  profileUrl?: (value: string, scope: string) => string;
}

export interface ChannelDef {
  id: string;
  label: string;
  kinds: string[];
  prefixes: string[];
  followupDays: number;
  staleDays: number;
  private: boolean;
  custom?: boolean;
  urlPattern?: string;
}

const bare = (u: string) => u.trim().replace(/^https?:\/\//i, "").replace(/^(www|m|mobile|web)\./i, "").replace(/\/+$/, "");
const handle = (re: RegExp, deny: string[] = []) => (v: string) => {
  const h = v.trim().replace(/^@/, "").toLowerCase();
  return re.test(h) && !deny.includes(h) ? h : null;
};
const path1 = (host: RegExp, re: RegExp) => (b: string) => {
  const m = b.match(host);
  return m ? (re.test(m[1]!) ? { value: m[1]!.toLowerCase() } : null) : null;
};

export function normalizePhone(v: string): string | null {
  const t = v.trim().replace(/^wa\s*:\s*/i, "");
  const digits = t.replace(/[\s().-]/g, "").replace(/^00/, "+");
  const d = digits.replace(/^\+/, "");
  return /^\d{8,15}$/.test(d) && !d.startsWith("0") ? `+${d}` : null;
}
/** +14155550123 -> +141******23 */
export const maskPhone = (v: string) => (v.length <= 6 ? "***" : `${v.slice(0, 4)}${"*".repeat(v.length - 6)}${v.slice(-2)}`);

const bsky = (v: string) => {
  const h = v.trim().replace(/^@/, "").toLowerCase();
  const full = h.includes(".") ? h : `${h}.bsky.social`;
  return /^(did:plc:[a-z0-9]{10,64}|([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,})$/.test(full) ? full : null;
};

export const IDENTITY_KINDS: IdentityKind[] = [
  { kind: "email", channel: "email", label: "Email", legacyColumn: "email", legacyArg: "email", normalize: (v) => normalizeEmail(v.replace(/^mailto:/i, "")), profileUrl: (v) => `mailto:${v}` },
  { kind: "linkedin_url", channel: "linkedin", label: "LinkedIn", legacyColumn: "linkedin", legacyArg: "linkedin_url", normalize: (v) => normalizeLinkedin(v), url: (b) => (/^([a-z]{2}\.)?linkedin\.com\//i.test(b) ? (normalizeLinkedin(b) ? { value: normalizeLinkedin(b)! } : null) : null), profileUrl: (v) => `https://${v}` },
  { kind: "x_handle", channel: "x", label: "X", legacyColumn: "xHandle", legacyArg: "x_handle", normalize: (v) => normalizeXHandle(v), url: (b) => (/^(x|twitter)\.com\//i.test(b) ? (normalizeXHandle(b) ? { value: normalizeXHandle(b)! } : null) : null), profileUrl: (v) => `https://x.com/${v}` },
  { kind: "reddit_user", channel: "reddit", label: "Reddit", legacyColumn: "redditUser", legacyArg: "reddit_user", normalize: (v) => normalizeRedditUser(v), url: (b) => (/^([a-z]+\.)?reddit\.com\/(u|user)\//i.test(b) ? (normalizeRedditUser(b) ? { value: normalizeRedditUser(b)! } : null) : null), profileUrl: (v) => `https://reddit.com/user/${v}` },
  { kind: "github", channel: "github", label: "GitHub", legacyColumn: "github", legacyArg: "github", normalize: (v) => normalizeGithub(v), url: (b) => (/^github\.com\//i.test(b) ? (normalizeGithub(b) ? { value: normalizeGithub(b)! } : null) : null), profileUrl: (v) => `https://github.com/${v}` },
  { kind: "threads_handle", channel: "threads", label: "Threads", legacyColumn: "threadsHandle", legacyArg: "threads_handle", normalize: (v) => normalizeThreadsHandle(v), url: (b) => (/^threads\.(net|com)\//i.test(b) ? (normalizeThreadsHandle(b) ? { value: normalizeThreadsHandle(b)! } : null) : null), profileUrl: (v) => `https://www.threads.net/@${v}` },
  {
    kind: "hn_user", channel: "hackernews", label: "Hacker News",
    normalize: handle(/^[a-z0-9_-]{2,15}$/),
    url: (b) => { const m = b.match(/^news\.ycombinator\.com\/user\?id=([A-Za-z0-9_-]{2,15})/i); return m ? { value: m[1]!.toLowerCase() } : null; },
    profileUrl: (v) => `https://news.ycombinator.com/user?id=${v}`,
  },
  {
    kind: "discord_user", channel: "discord", label: "Discord", scoped: true,
    normalize: (v) => (/^\d{15,21}$/.test(v.trim()) ? v.trim() : handle(/^[a-z0-9_.]{2,32}$/)(v.replace(/#0$/, ""))),
    url: (b) => { const m = b.match(/^discord(?:app)?\.com\/users\/(\d{15,21})/i); return m ? { value: m[1]! } : null; },
    profileUrl: (v) => (/^\d+$/.test(v) ? `https://discord.com/users/${v}` : ""),
  },
  {
    kind: "slack_user", channel: "slack_community", label: "Slack community", scoped: true,
    normalize: (v) => { const t = v.trim().replace(/^@/, ""); return /^[UW][A-Z0-9]{6,14}$/.test(t) ? t : /^[a-z0-9._-]{1,80}$/i.test(t) ? t.toLowerCase() : null; },
    url: (b) => { const m = b.match(/^([a-z0-9-]+)\.slack\.com\/team\/([UW][A-Z0-9]{6,14})/i); return m ? { value: m[2]!.toUpperCase(), scope: m[1]!.toLowerCase() } : null; },
    profileUrl: (v, s) => (s && /^[UW]/.test(v) ? `https://${s}.slack.com/team/${v}` : ""),
  },
  { kind: "bsky_handle", channel: "bluesky", label: "Bluesky", normalize: bsky, url: (b) => { const m = b.match(/^bsky\.app\/profile\/([^/?#]+)/i); return m && bsky(m[1]!) ? { value: bsky(m[1]!)! } : null; }, profileUrl: (v) => `https://bsky.app/profile/${v}` },
  { kind: "tiktok", channel: "tiktok", label: "TikTok", normalize: handle(/^[a-z0-9._]{2,24}$/), url: path1(/^tiktok\.com\/@([A-Za-z0-9._]{2,24})(?:[/?#]|$)/i, /./), profileUrl: (v) => `https://www.tiktok.com/@${v}` },
  {
    kind: "instagram", channel: "instagram", label: "Instagram",
    normalize: handle(/^(?!.*\.\.)(?!\.)[a-z0-9._]{1,30}$/, ["p", "reel", "reels", "explore", "stories", "accounts", "direct"]),
    url: (b) => { const m = b.match(/^instagram\.com\/([A-Za-z0-9._]{1,30})(?:[/?#]|$)/i); const v = m && handle(/^(?!.*\.\.)(?!\.)[a-z0-9._]{1,30}$/, ["p", "reel", "reels", "explore", "stories", "accounts", "direct"])(m[1]!); return v ? { value: v } : null; },
    profileUrl: (v) => `https://www.instagram.com/${v}`,
  },
  {
    kind: "youtube", channel: "youtube", label: "YouTube",
    normalize: (v) => { const t = v.trim(); if (/^(channel\/)?UC[A-Za-z0-9_-]{22}$/.test(t)) return `channel/${t.replace(/^channel\//, "")}`; const h = t.replace(/^@/, "").toLowerCase(); return /^[a-z0-9._-]{3,30}$/.test(h) ? `@${h}` : null; },
    url: (b) => { const m = b.match(/^youtube\.com\/(?:@([A-Za-z0-9._-]{3,30})|channel\/(UC[A-Za-z0-9_-]{22}))/i); return m ? { value: m[1] ? `@${m[1].toLowerCase()}` : `channel/${m[2]}` } : null; },
    profileUrl: (v) => `https://www.youtube.com/${v}`,
  },
  {
    kind: "facebook", channel: "facebook", label: "Facebook",
    normalize: (v) => { const t = v.trim().replace(/^@/, "").toLowerCase(); return /^\d{5,20}$/.test(t) || (/^[a-z0-9.]{5,50}$/.test(t) && !["profile.php", "groups", "pages", "events", "watch", "share"].includes(t)) ? t : null; },
    url: (b) => { const id = b.match(/^facebook\.com\/profile\.php\?id=(\d{5,20})/i); if (id) return { value: id[1]! }; const m = b.match(/^(?:facebook|fb)\.com\/([A-Za-z0-9.]{5,50})(?:[/?#]|$)/i); return m && !["profile.php", "groups", "pages", "events", "watch", "share"].includes(m[1]!.toLowerCase()) ? { value: m[1]!.toLowerCase() } : null; },
    profileUrl: (v) => (/^\d+$/.test(v) ? `https://www.facebook.com/profile.php?id=${v}` : `https://www.facebook.com/${v}`),
  },
  { kind: "telegram", channel: "telegram", label: "Telegram", normalize: handle(/^[a-z][a-z0-9_]{3,31}$/), url: (b) => { const m = b.match(/^(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{3,31})(?:[/?#]|$)/i); return m ? { value: m[1]!.toLowerCase() } : null; }, profileUrl: (v) => `https://t.me/${v}` },
  { kind: "whatsapp", channel: "whatsapp", label: "WhatsApp", private: true, normalize: normalizePhone, url: (b) => { const m = b.match(/^(?:wa\.me|api\.whatsapp\.com\/send\?phone=)\/?\+?(\d{8,15})/i); return m ? { value: `+${m[1]}` } : null; }, profileUrl: (v) => `https://wa.me/${v.replace(/^\+/, "")}` },
];
export const KIND_INDEX = new Map(IDENTITY_KINDS.map((k) => [k.kind, k]));
export const LEGACY_KINDS = IDENTITY_KINDS.filter((k) => k.legacyColumn);

const ch = (id: string, label: string, kinds: string[], prefixes: string[], followupDays: number, staleDays: number, priv = false): ChannelDef => ({ id, label, kinds, prefixes, followupDays, staleDays, private: priv });
export const BUILTIN_CHANNELS: ChannelDef[] = [
  ch("x", "X (Twitter)", ["x_handle"], ["x", "twitter"], 3, 6),
  ch("linkedin", "LinkedIn", ["linkedin_url"], ["li", "linkedin"], 5, 10),
  ch("reddit", "Reddit", ["reddit_user"], ["rd", "reddit"], 4, 8),
  ch("email", "Email", ["email"], ["email", "mailto"], 4, 8),
  ch("threads", "Threads (Meta)", ["threads_handle"], ["threads", "th"], 3, 6),
  ch("hackernews", "Hacker News", ["hn_user"], ["hn"], 4, 8),
  ch("github", "GitHub", ["github"], ["gh", "github"], 5, 10),
  ch("discord", "Discord", ["discord_user"], ["discord"], 3, 7),
  ch("slack_community", "Slack community", ["slack_user"], ["slack"], 3, 7),
  ch("bluesky", "Bluesky", ["bsky_handle"], ["bsky", "bluesky"], 3, 6),
  ch("tiktok", "TikTok", ["tiktok"], ["tiktok", "tt"], 4, 8),
  ch("instagram", "Instagram", ["instagram"], ["ig", "instagram"], 3, 6),
  ch("youtube", "YouTube", ["youtube"], ["yt", "youtube"], 5, 10),
  ch("facebook", "Facebook", ["facebook"], ["fb", "facebook"], 4, 8),
  ch("telegram", "Telegram", ["telegram"], ["tg", "telegram"], 3, 6),
  ch("whatsapp", "WhatsApp", ["whatsapp"], ["wa", "whatsapp"], 3, 6, true),
];
export const BUILTIN_INDEX = new Map(BUILTIN_CHANNELS.map((c) => [c.id, c]));
/** Channels with state rows that pre-date the registry; their per-channel export columns stay fixed. */
export const LEGACY_EXPORT_CHANNELS = ["x", "linkedin", "reddit", "email", "threads"];
/** Non-channel sources. */
export const EXTRA_SOURCES = ["web", "prowlo", "other"];
export const CHANNEL_ID_RE = /^[a-z][a-z0-9_]{0,31}$/;

// ---------- org custom channels
export interface CustomChannelConfig {
  id: string;
  label: string;
  urlPattern?: string | null; // e.g. "community.example.com/u/{handle}"
  prefix?: string | null;
  followupDays?: number | null;
  staleDays?: number | null;
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function patternRegex(p: string): RegExp {
  const b = bare(p);
  const [pre, post = ""] = b.split("{handle}");
  return new RegExp(`^${escapeRe(pre!).replace(/^/, "")}([^/?#&]+)${escapeRe(post)}(?:[/?#]|$)`, "i");
}
const customNorm = (v: string) => { const t = v.trim().replace(/^@/, "").toLowerCase(); return t && !/\s/.test(t) && t.length <= 200 ? t : null; };
export function customDef(c: CustomChannelConfig): { def: ChannelDef; kind: IdentityKind } {
  const kindId = c.id;
  const re = c.urlPattern ? patternRegex(c.urlPattern) : null;
  return {
    def: { id: c.id, label: c.label, kinds: [kindId], prefixes: c.prefix ? [c.prefix.toLowerCase()] : [], followupDays: c.followupDays ?? 3, staleDays: c.staleDays ?? (c.followupDays ?? 3) * 2, private: false, custom: true, urlPattern: c.urlPattern ?? undefined },
    kind: {
      kind: kindId, channel: c.id, label: c.label, normalize: customNorm,
      url: re ? (b) => { const m = b.match(re); return m && customNorm(decodeURIComponent(m[1]!)) ? { value: customNorm(decodeURIComponent(m[1]!))! } : null; } : undefined,
      profileUrl: c.urlPattern ? (v) => `https://${bare(c.urlPattern!).replace("{handle}", v)}` : undefined,
    },
  };
}

/** Registry view for one org (builtins + its custom channels). */
export class ChannelRegistry {
  readonly channels: ChannelDef[];
  readonly kinds: IdentityKind[];
  private chIdx: Map<string, ChannelDef>;
  private kIdx: Map<string, IdentityKind>;
  private prefixIdx: Map<string, IdentityKind>;
  constructor(custom: CustomChannelConfig[] = []) {
    const cs = custom.map(customDef);
    this.channels = [...BUILTIN_CHANNELS, ...cs.map((c) => c.def)];
    this.kinds = [...IDENTITY_KINDS, ...cs.map((c) => c.kind)];
    this.chIdx = new Map(this.channels.map((c) => [c.id, c]));
    this.kIdx = new Map(this.kinds.map((k) => [k.kind, k]));
    this.prefixIdx = new Map();
    for (const c of this.channels) for (const p of c.prefixes) this.prefixIdx.set(p, this.kIdx.get(c.kinds[0]!)!);
  }
  channel(id: string) { return this.chIdx.get(id); }
  kind(k: string) { return this.kIdx.get(k); }
  isChannel(id: string) { return this.chIdx.has(id); }
  isSource(id: string) { return this.chIdx.has(id) || EXTRA_SOURCES.includes(id); }
  /** Touch channels additionally allow "other". */
  isTouchChannel(id: string) { return this.chIdx.has(id) || id === "other"; }
  followupDays(id: string) { return this.chIdx.get(id)?.followupDays ?? 3; }
  staleDays(id: string) { return this.chIdx.get(id)?.staleDays ?? 7; }
  isPrivateKind(k: string) { return !!this.kIdx.get(k)?.private; }

  /** Normalizes {kind, value, scope}; kind may also be a channel id or prefix. */
  normalize(kind: string, value: string, scope?: string | null): Identity | null {
    const k = this.kIdx.get(kind) ?? (this.chIdx.get(kind) && this.kIdx.get(this.chIdx.get(kind)!.kinds[0]!)) ?? this.prefixIdx.get(kind.toLowerCase());
    if (!k) return null;
    let v = value.trim();
    let sc = (scope ?? "").trim().toLowerCase();
    const viaUrl = k.url?.(bare(v));
    if (viaUrl) return { kind: k.kind, value: viaUrl.value, scope: viaUrl.scope ?? (k.scoped ? sc : ""), raw: value };
    if (k.scoped && !sc) {
      // "server/user" or "user@server" shorthand
      const slash = v.indexOf("/"), at = v.lastIndexOf("@");
      if (slash > 0) [sc, v] = [v.slice(0, slash).toLowerCase(), v.slice(slash + 1)];
      else if (at > 0) [sc, v] = [v.slice(at + 1).toLowerCase(), v.slice(0, at)];
    }
    const n = k.normalize(v);
    return n ? { kind: k.kind, value: n, scope: k.scoped ? sc : "", raw: value } : null;
  }

  /** Parses "hn:pg", "discord:server/user", "https://bsky.app/profile/x" etc. */
  parse(raw: string): Identity | null {
    const t = raw.trim();
    const pre = t.match(/^([a-z][a-z0-9_]*)\s*:\s*(?!\/\/)(.+)$/i);
    if (pre && this.prefixIdx.has(pre[1]!.toLowerCase())) return this.normalize(this.prefixIdx.get(pre[1]!.toLowerCase())!.kind, pre[2]!);
    const b = bare(t);
    for (const k of this.kinds) {
      const r = k.url?.(b);
      if (r) return { kind: k.kind, value: r.value, scope: r.scope ?? "", raw };
    }
    return null;
  }

  display(i: { kind: string; value: string }, reveal: boolean) {
    return this.isPrivateKind(i.kind) && !reveal ? maskPhone(i.value) : i.value;
  }
}

export const BUILTIN_REGISTRY = new ChannelRegistry();
