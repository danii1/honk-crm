import { CircleX, SquareKanban } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { listContactsView, type Contact } from "@/client/lib/api";
import { STAGES } from "@/client/lib/constants";
import { contactHref } from "@/client/lib/links";
import { formatDay, titleCase } from "@/client/lib/utils";
import { useApp } from "@/client/App";
import { EmptyState } from "@/client/components/empty-state";
import { PageHeader } from "@/client/components/page-header";
import { ProfileLinks } from "@/client/components/profile-links";
import { StageBadge } from "@/client/components/stage-badge";
import { Badge } from "@/client/components/ui/badge";
import { Card } from "@/client/components/ui/card";
import { Skeleton } from "@/client/components/ui/skeleton";

export function PipelinePage() {
  const { pipeline } = useApp();
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listContactsView({ limit: 1000 })
      .then((r) => {
        setContacts(r.contacts);
        setTotal(r.total);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const byStage = useMemo(() => {
    const map = new Map<string, Contact[]>();
    for (const stage of STAGES) map.set(stage, []);
    for (const c of contacts ?? []) {
      if (!map.has(c.stage)) map.set(c.stage, []);
      map.get(c.stage)!.push(c);
    }
    return map;
  }, [contacts]);

  if (error) return <EmptyState title="Could not load the pipeline" description={error} icon={CircleX} />;

  return (
    <>
      <PageHeader
        title="Pipeline"
        description="Every stage at a glance. Cards link to the lead or contact timeline."
        actions={
          pipeline ? (
            <div className="flex gap-2">
              <Badge variant="outline">Leads {pipeline.lifecycles.lead}</Badge>
              <Badge variant="success">Contacts {pipeline.lifecycles.contact}</Badge>
              <Badge variant="muted">Archived {pipeline.lifecycles.archived}</Badge>
            </div>
          ) : null
        }
      />

      {contacts && contacts.length < total ? (
        <div className="mb-3 rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Showing the {contacts.length} most recently updated of {total} contacts; {total - contacts.length} older records are not shown.
        </div>
      ) : null}

      {!contacts ? (
        <div className="flex gap-3 overflow-hidden">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[28rem] w-72 shrink-0 rounded-xl" />)}
        </div>
      ) : contacts.length === 0 ? (
        <EmptyState title="No pipeline yet" description="Create or import leads to see them move across stages." icon={SquareKanban} />
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-3 scrollbar-thin">
          {STAGES.map((stage) => {
            const items = byStage.get(stage) ?? [];
            return (
              <section key={stage} className="flex w-72 shrink-0 flex-col rounded-xl border bg-muted/20">
                <header className="flex items-center justify-between gap-2 border-b bg-card px-3 py-2.5">
                  <StageBadge stage={stage} />
                  <span className="text-xs tabular-nums text-muted-foreground">{items.length}</span>
                </header>
                <div className="flex-1 space-y-2 p-2">
                  {items.length ? (
                    items.map((c) => <PipelineCard key={c.id} contact={c} />)
                  ) : (
                    <p className="rounded-lg border border-dashed px-3 py-8 text-center text-[11px] text-muted-foreground">Empty</p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

function PipelineCard({ contact }: { contact: Contact }) {
  return (
    <Card className="p-3 transition-shadow hover:shadow-md">
      <Link to={contactHref(contact)} className="block">
        <p className="truncate text-sm font-medium hover:text-primary">{contact.name || contact.email || contact.id.slice(0, 8)}</p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{contact.company?.name ?? contact.role ?? titleCase(contact.source) ?? "—"}</p>
      </Link>
      <div className="mt-2 flex items-center justify-between gap-2">
        <ProfileLinks identities={contact.identities} limit={4} />
        {contact.score ? <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">{contact.score}/5</span> : null}
      </div>
      <div className="mt-2 flex items-center justify-between border-t pt-2 text-[10px] text-muted-foreground">
        <span className="truncate">{contact.source ? titleCase(contact.source) : "—"}</span>
        <span className="shrink-0">{formatDay(contact.lastTouchAt)}</span>
      </div>
    </Card>
  );
}
