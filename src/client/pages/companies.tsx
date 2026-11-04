import { Building, CircleX, RotateCcw, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { listCompanies, type Company } from "@/client/lib/api";
import { EmptyState } from "@/client/components/empty-state";
import { PageHeader } from "@/client/components/page-header";
import { WebsiteLink } from "@/client/components/profile-links";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { Card } from "@/client/components/ui/card";
import { Input } from "@/client/components/ui/input";
import { Skeleton } from "@/client/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/client/components/ui/table";

const PAGE_SIZE = 500;

export function CompaniesPage() {
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setCompanies(null);
    setError(null);
    listCompanies(applied || undefined, offset)
      .then((r) => {
        if (!alive) return;
        setCompanies(r.companies);
        setTotal(r.total);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [applied, offset]);

  const start = companies?.length ? offset + 1 : 0;
  const end = offset + (companies?.length ?? 0);

  if (error) return <EmptyState title="Could not load companies" description={error} icon={CircleX} />;

  return (
    <>
      <PageHeader title="Companies" description="Accounts linked to your leads and contacts." actions={<Badge variant="muted" className="h-8 px-2.5 text-xs">{total} companies</Badge>} />

      <Card className="mb-4 p-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setOffset(0);
            setApplied(query.trim());
          }}
        >
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search company name or domain…" className="pl-9" aria-label="Search companies" />
          </div>
          <Button type="submit" size="sm">Search</Button>
          {applied ? <Button type="button" variant="ghost" size="sm" onClick={() => { setQuery(""); setApplied(""); setOffset(0); }}><RotateCcw className="size-4" /> Reset</Button> : null}
        </form>
      </Card>

      {!companies ? (
        <Card className="p-3"><div className="space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-11 w-full" />)}</div></Card>
      ) : companies.length ? (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Company</TableHead>
                <TableHead>Domain</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Team size</TableHead>
                <TableHead>Leads</TableHead>
                <TableHead>Relationships</TableHead>
                <TableHead>Published email</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {companies.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="max-w-64">
                    <p className="truncate font-medium">{c.name}</p>
                    {c.stack?.length ? <p className="truncate text-[11px] text-muted-foreground">{c.stack.join(" · ")}</p> : null}
                  </TableCell>
                  <TableCell><WebsiteLink url={c.website_url} label={c.domain ?? c.website ?? "—"} className="text-xs" /></TableCell>
                  <TableCell className="text-xs text-muted-foreground">{c.type ?? "—"}</TableCell>
                  <TableCell className="text-xs tabular-nums text-muted-foreground">{c.teamSize?.toLocaleString() ?? "—"}</TableCell>
                  <TableCell><Badge variant="outline">{c.leads ?? 0}</Badge></TableCell>
                  <TableCell><Badge variant="success">{c.relationships ?? 0}</Badge></TableCell>
                  <TableCell className="max-w-48 truncate text-xs">
                    {c.publishedEmail ? <a className="text-primary hover:underline" href={`mailto:${c.publishedEmail}`}>{c.publishedEmail}</a> : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {total > PAGE_SIZE ? (
            <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
              <span>Showing {start}–{end} of {total}</span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Previous</Button>
                <Button variant="outline" size="sm" disabled={end >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</Button>
              </div>
            </div>
          ) : null}
        </Card>
      ) : (
        <EmptyState title={applied ? "No matching companies" : "No companies yet"} description={applied ? "Try a different name or domain." : "Companies are created automatically from work-email domains and CSV imports."} icon={Building} />
      )}
    </>
  );
}
