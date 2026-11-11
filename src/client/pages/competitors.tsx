import { Ban, CircleX, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, listCompetitors, type Competitor } from "@/client/lib/api";
import { useApp } from "@/client/App";
import { formatDay, titleCase } from "@/client/lib/utils";
import { EmptyState } from "@/client/components/empty-state";
import { PageHeader } from "@/client/components/page-header";
import { RecordFormDialog, type FormField } from "@/client/components/record-form-dialog";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { Card } from "@/client/components/ui/card";
import { Input } from "@/client/components/ui/input";
import { Skeleton } from "@/client/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/client/components/ui/table";

export function CompetitorsPage() {
  const { canWrite, me } = useApp();
  const canManage = canWrite && (me.role === "admin" || me.role === "owner");
  const [rows, setRows] = useState<Competitor[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    listCompetitors().then(setRows).catch((e: Error) => setError(e.message));
  }, [revision]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => [r.displayName, r.value, r.label, r.kind].some((v) => v?.toLowerCase().includes(q)));
  }, [rows, query]);

  if (error) return <EmptyState title="Could not load competitors" description={error} icon={CircleX} />;

  return (
    <>
      <PageHeader
        title="Competitors"
        description="Keep outreach away from people and companies on your blocklist."
        actions={<>
          {canManage ? <CompetitorForm trigger={<Button size="sm"><Plus className="size-4" /> Add competitor</Button>} onSaved={() => setRevision((n) => n + 1)} /> : null}
          <Badge variant="muted" className="h-8 px-2.5 text-xs">{rows?.length ?? 0} entries</Badge>
        </>}
      />

      <Card className="mb-4 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search competitors…" className="pl-9" aria-label="Search competitors" />
        </div>
      </Card>

      {!rows ? (
        <Card className="p-3"><div className="space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-11 w-full" />)}</div></Card>
      ) : filtered.length ? (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Competitor</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Matching key</TableHead>
                <TableHead>Match</TableHead>
                <TableHead>Label</TableHead>
                <TableHead>Added</TableHead>
                {canManage ? <TableHead><span className="sr-only">Actions</span></TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="max-w-64">
                    <p className="truncate font-medium">{r.displayName || r.value}</p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">{r.id}</p>
                  </TableCell>
                  <TableCell><Badge variant="outline">{titleCase(r.kind)}</Badge></TableCell>
                  <TableCell className="max-w-64 truncate font-mono text-[11px] text-muted-foreground">{r.value}</TableCell>
                  <TableCell><Badge variant={r.match === "exact" ? "default" : "warning"}>{r.match}</Badge></TableCell>
                  <TableCell className="max-w-48 truncate text-xs text-muted-foreground">{r.label ?? "—"}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDay(r.createdAt)}</TableCell>
                  {canManage ? <TableCell><div className="flex gap-1">
                    <CompetitorForm competitor={r} trigger={<Button variant="ghost" size="sm"><Pencil className="size-3.5" /> Edit</Button>} onSaved={() => setRevision((n) => n + 1)} />
                    <RecordFormDialog trigger={<Button variant="ghost" size="sm" className="text-destructive"><Trash2 className="size-3.5" /> Remove</Button>}
                      title="Remove competitor" description={`Remove ${r.displayName || r.value} from the outreach blocklist?`}
                      fields={[]} submitLabel="Remove entry" onSave={() => api("remove_competitor", { id: r.id })} onSaved={() => setRevision((n) => n + 1)} />
                  </div></TableCell> : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : (
        <EmptyState title={query ? "No matching competitors" : "No competitors yet"} description={query ? "Try a different name or handle." : "Add a company, domain, or handle to protect your outreach."} icon={Ban} />
      )}
    </>
  );
}

function CompetitorForm({ competitor, trigger, onSaved }: { competitor?: Competitor; trigger: React.ReactNode; onSaved: () => void }) {
  const fields: FormField[] = [
    { name: "value", label: "Name, domain, or handle", value: competitor?.displayName || competitor?.value, required: true, full: true, placeholder: "example.com or @handle" },
    ...(!competitor ? [{ name: "kind", label: "Type", type: "select" as const, value: "", options: [{ value: "", label: "Detect automatically" }, ...["name", "domain", "handle"].map((value) => ({ value, label: titleCase(value) }))] }] : []),
    { name: "match", label: "Match", type: "select", value: competitor?.match ?? "", options: [{ value: "", label: "Default" }, { value: "exact", label: "Exact" }, { value: "fuzzy", label: "Fuzzy" }] },
    { name: "label", label: "Display label", value: competitor?.label, placeholder: "Optional" },
  ];
  return <RecordFormDialog trigger={trigger} title={competitor ? "Edit competitor" : "Add competitor"}
    description="Block matching prospects before outreach is recorded." fields={fields} onSaved={onSaved}
    submitLabel={competitor ? "Save changes" : "Add competitor"}
    onSave={(v) => api(competitor ? "update_competitor" : "add_competitor", {
      ...(competitor ? { id: competitor.id } : {}), value: (v.value ?? "").trim(),
      ...(v.kind && { kind: v.kind }), ...(v.match && { match: v.match }),
      ...(competitor || v.label?.trim() ? { label: v.label?.trim() ?? "" } : {}),
    })} />;
}
