/** Read-only dashboard (server-rendered Hono JSX, no client JS). */
import type { Child, FC } from "hono/jsx";
import { OUTREACH_CHANNELS, SOURCES, STAGES } from "./db/schema";
import type { CrmService } from "./service";

const TZ = "Asia/Saigon";
const fmt = (d?: Date | string | null) => {
  if (!d) return "—";
  const x = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(x.getTime()) ? "—" : new Intl.DateTimeFormat("en-GB", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" }).format(x);
};
const day = (d?: Date | string | null) => (d ? new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(d)) : "—");

const CSS = `
*{box-sizing:border-box}body{font:14px/1.45 system-ui,-apple-system,sans-serif;margin:0;color:#1d2329;background:#f6f7f9}
header{background:#fff;border-bottom:1px solid #e3e6ea;padding:12px 24px;display:flex;gap:20px;align-items:center}
header b{font-size:16px}header a{color:#3a4450;text-decoration:none}header a:hover{text-decoration:underline}
main{max-width:1200px;margin:0 auto;padding:20px 24px}
h2{font-size:15px;margin:0 0 10px}h1{font-size:20px;margin:0 0 16px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px}
.card{background:#fff;border:1px solid #e3e6ea;border-radius:8px;padding:14px 16px;overflow:auto}
.kpis{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px}.kpi{background:#fff;border:1px solid #e3e6ea;border-radius:8px;padding:10px 14px;min-width:140px}
.kpi span{display:block;color:#6b7580;font-size:12px}.kpi b{font-size:20px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:5px 6px;border-bottom:1px solid #eef0f2;vertical-align:top}th{color:#6b7580;font-weight:500;font-size:12px}
.muted{color:#8a939c}.pill{display:inline-block;padding:1px 7px;border-radius:10px;background:#eef2f7;font-size:12px}
.bad{color:#b42318}.ok{color:#067647}form.filters{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}select,button{padding:5px 8px}
.text{max-width:420px;white-space:pre-wrap}`;

const Layout: FC<{ title: string; children?: Child }> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>{title} · Outreach CRM</title>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
    </head>
    <body>
      <header>
        <b>Outreach CRM</b>
        <a href="/dashboard">Overview</a>
        <a href="/dashboard/contacts">Contacts</a>
        <span class="muted" style="margin-left:auto">read-only · times in Asia/Saigon (UTC+7)</span>
      </header>
      <main>{children}</main>
    </body>
  </html>
);

const Who: FC<{ id: string; name?: string | null }> = ({ id, name }) => <a href={`/dashboard/contacts/${id}`}>{name || id.slice(0, 8)}</a>;
const Empty = () => <p class="muted">Nothing here.</p>;

export async function overviewPage(svc: CrmService) {
  const o = await svc.daily_overview({});
  const g = o.goal;
  return (
    <Layout title="Overview">
      <h1>Today · {o.date}</h1>
      <div class="kpis">
        <div class="kpi"><span>Paying (goal 3)</span><b>{g.paying}</b></div>
        <div class="kpi"><span>Pilots (goal 10)</span><b>{g.pilots}</b></div>
        <div class="kpi"><span>Days left to 2026-12-15</span><b>{g.days_left}</b></div>
        <div class="kpi"><span>Contacted / responded</span><b>{o.totals.contacted} / {o.totals.responded}</b></div>
        <div class="kpi"><span>X sent today</span><b class={o.x_pacing.ok_to_send ? "ok" : "bad"}>{o.x_pacing.sent_today} / {o.x_pacing.sent_today + o.x_pacing.remaining_today}</b></div>
      </div>
      <div class="grid">
        <div class="card">
          <h2>Follow-ups due ({o.followups_due.length})</h2>
          {o.followups_due.length ? (
            <table><tr><th>Contact</th><th>Channel</th><th>Stage</th><th>Due</th><th>Next step</th></tr>
              {o.followups_due.map((f) => (
                <tr><td><Who id={f.contact_id} name={f.name} /></td><td>{f.channel}</td><td><span class="pill">{f.stage}</span></td><td class={f.overdue ? "bad" : ""}>{day(f.next_followup_at)}</td><td>{f.next_step ?? ""}</td></tr>
              ))}
            </table>
          ) : <Empty />}
        </div>
        <div class="card">
          <h2>New replies, last 24h ({o.new_replies.length})</h2>
          {o.new_replies.length ? (
            <table><tr><th>Contact</th><th>Channel</th><th>When</th><th>Summary</th></tr>
              {o.new_replies.map((e) => <tr><td><Who id={e.contactId} name={e.name} /></td><td>{e.channel}</td><td>{fmt(e.occurredAt)}</td><td>{e.summary ?? ""}</td></tr>)}
            </table>
          ) : <Empty />}
        </div>
        <div class="card">
          <h2>LinkedIn: connected, awaiting first message ({o.linkedin_awaiting_first_message.length})</h2>
          {o.linkedin_awaiting_first_message.length ? (
            <table><tr><th>Contact</th><th>Stage</th><th>Next step</th></tr>
              {o.linkedin_awaiting_first_message.map((x) => <tr><td><Who id={x.contact_id} name={x.name} /></td><td>{x.stage}</td><td>{x.next_step ?? ""}</td></tr>)}
            </table>
          ) : <Empty />}
        </div>
        <div class="card">
          <h2>Drafts pending ({o.drafts_pending.length})</h2>
          {o.drafts_pending.length ? (
            <table><tr><th>Contact</th><th>Channel</th><th>State</th><th>Text</th></tr>
              {o.drafts_pending.map((d) => <tr><td><Who id={d.contact_id} name={d.name} /></td><td>{d.channel}</td><td><span class="pill">{d.state}</span></td><td class="text">{d.text.length > 160 ? `${d.text.slice(0, 160)}…` : d.text}</td></tr>)}
            </table>
          ) : <Empty />}
        </div>
        <div class="card">
          <h2>Stale, no response ({o.stale.length})</h2>
          {o.stale.length ? (
            <table><tr><th>Contact</th><th>Channel</th><th>Stage</th><th>Days</th></tr>
              {o.stale.map((x) => <tr><td><Who id={x.contact_id} name={x.name} /></td><td>{x.channel}</td><td>{x.stage}</td><td>{x.days_since} (≥{x.threshold_days})</td></tr>)}
            </table>
          ) : <Empty />}
        </div>
        <div class="card">
          <h2>X pacing</h2>
          <table>
            <tr><td>Drafted today</td><td>{o.x_pacing.drafted_today}</td></tr>
            <tr><td>Sent today</td><td>{o.x_pacing.sent_today}</td></tr>
            <tr><td>Remaining</td><td>{o.x_pacing.remaining_today}</td></tr>
            <tr><td>Last sent</td><td>{fmt(o.x_pacing.last_sent_at)}</td></tr>
            <tr><td>OK to send</td><td class={o.x_pacing.ok_to_send ? "ok" : "bad"}>{o.x_pacing.ok_to_send ? "yes" : `no, next at ${fmt(o.x_pacing.next_allowed_at)}`}</td></tr>
          </table>
        </div>
        <div class="card">
          <h2>Leads by stage</h2>
          <table>
            {Object.entries(o.stages).filter(([, n]) => n).map(([st, n]) => <tr><td><a href={`/dashboard/contacts?stage=${st}`}>{st}</a></td><td>{n}</td></tr>)}
          </table>
        </div>
      </div>
    </Layout>
  );
}

const Select: FC<{ name: string; value?: string; options: readonly string[] }> = ({ name, value, options }) => (
  <select name={name}>
    <option value="">any {name}</option>
    {options.map((o) => <option value={o} selected={o === value}>{o}</option>)}
  </select>
);

const pickEnum = <T extends string>(v: string | undefined, all: readonly T[]) => (v && (all as readonly string[]).includes(v) ? (v as T) : undefined);

export async function contactsPage(svc: CrmService, q: { stage?: string; channel?: string; source?: string }) {
  const stage = pickEnum(q.stage, STAGES), channel = pickEnum(q.channel, OUTREACH_CHANNELS), source = pickEnum(q.source, SOURCES);
  const rows = await svc.list_contacts({ stage: channel ? undefined : stage, channel, channel_stage: channel ? stage : undefined, source, limit: 500 });
  return (
    <Layout title="Contacts">
      <h1>Contacts ({rows.length})</h1>
      <form class="filters" method="get">
        <Select name="stage" value={stage} options={STAGES} />
        <Select name="channel" value={channel} options={OUTREACH_CHANNELS} />
        <Select name="source" value={source} options={SOURCES} />
        <button>Filter</button> <a href="/dashboard/contacts">reset</a>
      </form>
      <p class="muted">{channel && stage ? `Stage filter applies to the ${channel} channel.` : ""}</p>
      <div class="card">
        <table>
          <tr><th>Name</th><th>Stage</th><th>Source</th><th>Handles</th><th>Last touch</th><th>Score</th></tr>
          {rows.map((c) => (
            <tr>
              <td><Who id={c.id} name={c.name} />{c.contactType === "competitor" ? <span class="pill"> competitor</span> : ""}</td>
              <td><span class="pill">{c.stage}</span></td>
              <td>{c.source ?? ""}</td>
              <td class="muted">{[c.xHandle && `x:@${c.xHandle}`, c.linkedin && "linkedin", c.redditUser && `u/${c.redditUser}`, c.threadsHandle && `threads:@${c.threadsHandle}`, c.email].filter(Boolean).join(" · ")}</td>
              <td>{fmt(c.lastTouchAt)}</td>
              <td>{c.score ?? ""}</td>
            </tr>
          ))}
        </table>
      </div>
    </Layout>
  );
}

export async function contactPage(svc: CrmService, id: string) {
  const c = await svc.get_contact({ id });
  const [events, activity] = await Promise.all([svc.repo.eventsForContact(id), svc.repo.activity({ entityType: "contact", entityId: id, limit: 100 })]);
  type Item = { at: Date; kind: string; text: string };
  const timeline: Item[] = [
    ...c.touches.map((t) => ({ at: t.sentAt ?? t.createdAt, kind: `${t.direction} ${t.channel}`, text: t.body ?? t.subject ?? t.status })),
    ...events.map((e) => ({ at: e.occurredAt, kind: `${e.type} (${e.channel})`, text: e.summary ?? "" })),
    ...c.drafts.map((d) => ({ at: d.sentAt ?? d.createdAt, kind: `draft ${d.state} (${d.channel})`, text: d.text })),
    ...c.notes.map((n) => ({ at: n.createdAt, kind: "note", text: n.body })),
    ...activity.filter((a) => a.action.endsWith("stage_changed")).map((a) => {
      const p = (a.payload ?? {}) as { from?: string; to?: string; channel?: string };
      return { at: a.createdAt, kind: "stage", text: `${p.channel ? `${p.channel}: ` : ""}${p.from} → ${p.to}` };
    }),
  ].toSorted((a, b) => b.at.getTime() - a.at.getTime());
  return (
    <Layout title={c.name ?? "Contact"}>
      <h1>{c.name ?? c.id} <span class="pill">{c.stage}</span></h1>
      <div class="grid">
        <div class="card">
          <h2>Profile</h2>
          <table>
            {([["Company", c.company?.name], ["Role", c.role], ["Source", c.source], ["X", c.xHandle && `@${c.xHandle}`], ["LinkedIn", c.linkedin], ["Reddit", c.redditUser && `u/${c.redditUser}`], ["Threads", c.threadsHandle && `@${c.threadsHandle}`], ["Email", c.email], ["Score", c.score], ["Signal", c.signalSummary], ["Notes", c.notesText]] as const)
              .filter(([, v]) => v !== null && v !== undefined && v !== "")
              .map(([k, v]) => <tr><th>{k}</th><td class="text">{String(v)}</td></tr>)}
          </table>
        </div>
        <div class="card">
          <h2>Channels</h2>
          {c.channel_states.length ? (
            <table><tr><th>Channel</th><th>Stage</th><th>Last touch</th><th>Follow-up</th><th>Next step</th></tr>
              {c.channel_states.map((s) => <tr><td>{s.channel}</td><td><span class="pill">{s.stage}</span></td><td>{fmt(s.lastTouchAt)}</td><td>{day(s.nextFollowupAt)}</td><td>{s.nextStep ?? ""}</td></tr>)}
            </table>
          ) : <Empty />}
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <h2>Timeline</h2>
        {timeline.length ? (
          <table><tr><th>When</th><th>What</th><th>Detail</th></tr>
            {timeline.map((t) => <tr><td style="white-space:nowrap">{fmt(t.at)}</td><td>{t.kind}</td><td class="text">{t.text}</td></tr>)}
          </table>
        ) : <Empty />}
      </div>
    </Layout>
  );
}
