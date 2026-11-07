import { Ban, CircleX, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { listCompetitors, type Competitor } from "@/client/lib/api";
import { formatDay, titleCase } from "@/client/lib/utils";
import { EmptyState } from "@/client/components/empty-state";
import { PageHeader } from "@/client/components/page-header";
import { Badge } from "@/client/components/ui/badge";
import { Card } from "@/client/components/ui/card";
import { Input } from "@/client/components/ui/input";
import { Skeleton } from "@/client/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/client/components/ui/table";

export function CompetitorsPage() {
  const [rows, setRows] = useState<Competitor[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listCompetitors().then(setRows).catch((e: Error) => setError(e.message));
  }, []);

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
        description="The blocklist used to reject pitches to competitors. Managed through the admin tools; this view is read-only."
        actions={<Badge variant="muted" className="h-8 px-2.5 text-xs">{rows?.length ?? 0} entries</Badge>}
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
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : (
        <EmptyState title={query ? "No matching competitors" : "No competitors yet"} description={query ? "Try a different name or handle." : "Add competitors with the admin MCP/REST tools to protect your outreach."} icon={Ban} />
      )}
    </>
  );
}
