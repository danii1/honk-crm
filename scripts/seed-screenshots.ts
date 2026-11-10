/** Populate an isolated local D1 database with fictional data for UI screenshots. */
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.SCREENSHOT_URL ?? "http://localhost:5174";
const email = "screenshots@example.test";
const password = crypto.randomUUID() + "-Honk-demo-2026!";
let cookie = "";
let orgId = "";

async function post(path: string, body: Record<string, unknown>) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: base,
      ...(cookie ? { cookie } : {}),
      ...(orgId ? { "x-org-id": orgId } : {}),
    },
    body: JSON.stringify(body),
  });
  const setCookies = response.headers.getSetCookie().map((value) => value.split(";")[0]);
  if (setCookies.length) cookie = setCookies.join("; ");
  const result = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok || result.error) throw new Error(`${path}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}

const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const today = new Date();
const deadline = new Date(today.getTime() + 45 * 86_400_000).toISOString().slice(0, 10);

await post("/api/auth/sign-up/email", { email, password, name: "Demo Owner" });
const org = await post("/api/auth/organization/create", { name: "Honk Demo", slug: "honk-demo" });
orgId = org.id;
if (!orgId) throw new Error(`Organization creation returned no id: ${JSON.stringify(org)}`);

const tool = (name: string, body: Record<string, unknown> = {}) => post(`/v1/${name}`, body);

const companies = [
  ["Northstar Labs", "northstar.example", "startup", 24, ["TypeScript", "Cloudflare"]],
  ["Willow Studio", "willow.example", "agency", 12, ["React", "Figma"]],
  ["Fern Analytics", "fern.example", "startup", 38, ["Python", "Postgres"]],
  ["Riverbend Health", "riverbend.example", "enterprise", 160, ["Salesforce", "Snowflake"]],
  ["Moss & Co", "moss.example", "agency", 18, ["Notion", "HubSpot"]],
  ["Pinecone Works", "pinecone.example", "startup", 9, ["Next.js", "Supabase"]],
] as const;
for (const [name, domain, type, team_size, stack] of companies) {
  await tool("upsert_company", { name, domain, type, team_size, stack: [...stack], website: `https://${domain}` });
}

const people = [
  { name: "Hana Sato", company: "willow.example", role: "Founder", stage: "call_booked", channel: "email", score: 5 },
  { name: "Priya Raman", company: "fern.example", role: "Head of Growth", stage: "responded", channel: "email", score: 5 },
  { name: "Mateo Silva", company: "northstar.example", role: "VP Sales", stage: "contacted", channel: "linkedin", score: 4 },
  { name: "Sofia Rossi", company: "moss.example", role: "Partner", stage: "connected", channel: "threads", score: 4 },
  { name: "Daniel Kim", company: "pinecone.example", role: "Co-founder", stage: "connected", channel: "linkedin", score: 4 },
  { name: "Noah Williams", company: "northstar.example", role: "CEO", stage: "drafted", channel: "x", score: 5 },
  { name: "Emil Novak", company: "riverbend.example", role: "Operations Lead", stage: "contacted", channel: "email", score: 3 },
  { name: "Amina Yusuf", company: "willow.example", role: "Creative Director", stage: "qualified", channel: "x", score: 4 },
  { name: "Leo Martin", company: "fern.example", role: "Growth Analyst", stage: "new", channel: "reddit", score: 3 },
  { name: "Iris Chen", company: "pinecone.example", role: "Product Lead", stage: "new", channel: "email", score: 4 },
  { name: "Olivia Park", company: "riverbend.example", role: "Director", stage: "pilot", channel: "email", score: 5 },
  { name: "Ethan Brooks", company: "moss.example", role: "Founder", stage: "paying", channel: "linkedin", score: 5 },
  { name: "Maya Patel", company: "northstar.example", role: "Community Lead", stage: "lost", channel: "x", score: 2 },
  { name: "Jules Moreau", company: "fern.example", role: "Recruiter", stage: "do_not_contact", channel: "email", score: 1 },
] as const;

const ids = new Map<string, string>();
for (const person of people) {
  const username = person.name.toLowerCase().replace(/[^a-z]+/g, ".").replace(/\.$/, "");
  const result = await tool("upsert_contact", {
    name: person.name,
    email: `${username}@${person.company}`,
    role: person.role,
    stage: person.stage,
    score: person.score,
    source: "web",
    company_domain: person.company,
    bio_summary: `${person.role} at ${companies.find((c) => c[1] === person.company)?.[0]}. Exploring more thoughtful outreach workflows.`,
    tags: person.score >= 4 ? ["priority"] : ["research"],
  });
  const id = result.id ?? result.contact?.id ?? result.contact_id;
  if (!id) throw new Error(`Contact creation returned no id: ${JSON.stringify(result)}`);
  ids.set(person.name, id);
  if (person.stage !== "lost" && person.stage !== "do_not_contact") {
    await tool("set_channel_state", { contact_id: id, channel: person.channel, stage: person.stage });
  }
}

for (const [name, channel, days, next_step] of [
  ["Hana Sato", "email", -2, "Prepare the demo"],
  ["Mateo Silva", "linkedin", -1, "Send a follow-up note"],
  ["Emil Novak", "email", -1, "Share the case study"],
  ["Daniel Kim", "linkedin", 0, "Send first message"],
  ["Sofia Rossi", "threads", 0, "Send first message"],
] as const) {
  await tool("set_channel_state", { contact_id: ids.get(name), channel, next_followup_at: day(days), next_step });
}

await tool("create_task", { title: "Review Hana's demo agenda", contact_id: ids.get("Hana Sato"), due_at: day(-1) });
await tool("create_task", { title: "Send pilot pricing to Priya", contact_id: ids.get("Priya Raman"), due_at: day(0) });
await tool("add_note", { entity_id: ids.get("Priya Raman"), body: "Interested in a three-week pilot for the growth team." });
await tool("add_note", { entity_id: ids.get("Hana Sato"), body: "Asked for a walkthrough of the agent-assisted pipeline." });

await tool("record_event", { contact_id: ids.get("Priya Raman"), type: "email_reply", channel: "email", external_id: "demo-priya-reply", occurred_at: day(-0.05), summary: "Interested in the pilot; asked for pricing." });
await tool("log_touch", { contact_id: ids.get("Mateo Silva"), channel: "linkedin", direction: "outbound", status: "sent", body: "Enjoyed your post about practical sales workflows.", sent_at: day(-5) });
await tool("log_touch", { contact_id: ids.get("Olivia Park"), channel: "email", direction: "inbound", status: "replied", body: "The pilot team is ready to start next week.", sent_at: day(-1) });

for (const [name, channel, text] of [
  ["Priya Raman", "email", "Hi Priya, thanks for the reply. Here is the pilot proposal we discussed: three weeks, one channel, no retainer."],
  ["Sofia Rossi", "threads", "Hey Sofia — loved your post on lifecycle automation. Open to a quick look at how Honk keeps the next step visible?"],
  ["Noah Williams", "x", "Noah — saw your team building agent infrastructure at Northstar. Would be great to compare notes on outbound workflows."],
] as const) {
  await tool("create_draft", { contact_id: ids.get(name), channel, text });
}

await tool("set_goals", { targets: [{ stage: "pilot", count: 10 }, { stage: "paying", count: 3 }], deadline });
for (const value of ["rivalcrm.example", "Gooseforce", "@rivalcrm"]) await tool("add_competitor", { value });

mkdirSync(".wrangler/screenshot-config", { recursive: true });
writeFileSync(".wrangler/screenshot-config/login.json", JSON.stringify({ base, email, password, orgId, ids: Object.fromEntries(ids) }, null, 2), { mode: 0o600 });
console.log(`Seeded ${people.length} fictional contacts, ${companies.length} companies, and demo activity.`);
