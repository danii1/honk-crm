#!/usr/bin/env bun
/**
 * Import a leads CSV into the CRM over the REST mirror of the MCP tools.
 *   CRM_URL=https://crm.example.com CRM_API_KEY=ocrm_… bun scripts/import-leads.ts leads.csv            # dry run (default)
 *   CRM_URL=… CRM_API_KEY=… bun scripts/import-leads.ts leads.csv --commit [--campaign <id>] [--chunk 50]
 * Rows are sent in chunks (header repeated) with a per-chunk idempotency key derived from the file
 * contents, so re-running after a failure is safe.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseCsv, toCsv } from "../src/csv";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a) && args[args.indexOf(a) - 1] !== "--campaign");
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const base = (process.env.CRM_URL ?? "http://localhost:5173").replace(/\/$/, "");
const key = process.env.CRM_API_KEY;
if (!file || !key) {
  console.error("usage: CRM_URL=… CRM_API_KEY=ocrm_… bun scripts/import-leads.ts <file.csv> [--commit] [--campaign id] [--chunk 50]");
  process.exit(2);
}
const commit = flag("commit");
const chunk = Number(opt("chunk") ?? 50);
const [header, ...rows] = parseCsv(await readFile(file, "utf8"));
if (!header) throw new Error("empty CSV");
const totals = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
const issues: unknown[] = [];
for (let off = 0; off < rows.length; off += chunk) {
  const csv = toCsv(header, rows.slice(off, off + chunk));
  const idem = `import:${createHash("sha256").update(csv).digest("hex").slice(0, 32)}`;
  const res = await fetch(`${base}/v1/import_leads_csv`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, ...(commit && { "idempotency-key": idem }) },
    body: JSON.stringify({ csv, dry_run: !commit, row_offset: off, campaign_id: opt("campaign"), reason: `csv import ${file}` }),
  });
  const body = (await res.json()) as Record<string, any>;
  if (!res.ok) throw new Error(`chunk at row ${off + 2}: HTTP ${res.status} ${JSON.stringify(body)}`);
  for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += body[k] ?? 0;
  for (const r of body.rows ?? []) if (r.action === "skipped" || r.warnings?.length) issues.push(r);
  if (Object.keys(body.unknown_statuses ?? {}).length) console.error("unknown statuses:", body.unknown_statuses);
  if (body.missing_columns?.length && off === 0) console.error("missing columns:", body.missing_columns.join(", "));
}
console.log(JSON.stringify({ mode: commit ? "commit" : "dry-run", rows: rows.length, ...totals, issues }, null, 2));
if (!commit) console.log("\nDry run only. Re-run with --commit to write.");
