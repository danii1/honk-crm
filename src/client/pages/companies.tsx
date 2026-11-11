import { Building, CircleX, Pencil, Plus, RotateCcw, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { api, listCompanies, type Company } from "@/client/lib/api";
import { useApp } from "@/client/App";
import { EmptyState } from "@/client/components/empty-state";
import { PageHeader } from "@/client/components/page-header";
import { WebsiteLink } from "@/client/components/profile-links";
import { RecordFormDialog, type FormField } from "@/client/components/record-form-dialog";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { Card } from "@/client/components/ui/card";
import { Input } from "@/client/components/ui/input";
import { Skeleton } from "@/client/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/client/components/ui/table";

const PAGE_SIZE = 500;

export function CompaniesPage() {
  const { canWrite } = useApp();
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

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
  }, [applied, offset, revision]);

  const start = companies?.length ? offset + 1 : 0;
  const end = offset + (companies?.length ?? 0);

  if (error) return <EmptyState title="Could not load companies" description={error} icon={CircleX} />;

  return (
    <>
      <PageHeader title="Companies" description="Accounts linked to your leads and contacts." actions={<>
        {canWrite ? <CompanyForm trigger={<Button size="sm"><Plus className="size-4" /> Add company</Button>} onSaved={() => setRevision((n) => n + 1)} /> : null}
        <Badge variant="muted" className="h-8 px-2.5 text-xs">{total} companies</Badge>
      </>} />

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
                {canWrite ? <TableHead><span className="sr-only">Actions</span></TableHead> : null}
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
                  {canWrite ? <TableCell><CompanyForm company={c} trigger={<Button variant="ghost" size="sm"><Pencil className="size-3.5" /> Edit</Button>} onSaved={() => setRevision((n) => n + 1)} /></TableCell> : null}
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

function CompanyForm({ company, trigger, onSaved }: { company?: Company; trigger: React.ReactNode; onSaved: () => void }) {
  const fields: FormField[] = [
    { name: "name", label: "Company name", value: company?.name, required: true },
    ...(company && !company.domain ? [] : [{ name: "domain", label: "Domain", value: company?.domain, required: true, readOnly: !!company, placeholder: "example.com", help: company ? "The domain identifies this company and cannot be changed." : "Honk uses this to match people to the company." }]),
    { name: "website", label: "Website", value: company?.website, placeholder: "https://example.com" },
    { name: "linkedin", label: "LinkedIn", value: company?.linkedin, placeholder: "linkedin.com/company/example" },
    { name: "type", label: "Type", value: company?.type, placeholder: "startup, agency, enterprise…" },
    { name: "team_size", label: "Team size", type: "number", min: 0, value: company?.teamSize },
    { name: "stack", label: "Stack", value: company?.stack?.join(", "), full: true, placeholder: "React, Postgres, Cloudflare", help: "Comma-separated." },
    { name: "published_email", label: "Published email", type: "email", value: company?.publishedEmail, full: true },
  ];
  return <RecordFormDialog trigger={trigger} title={company ? "Edit company" : "Add company"} description="Keep the account details your team uses for outreach."
    fields={fields} submitLabel={company ? "Save changes" : "Add company"} onSaved={onSaved}
    onSave={(values) => {
      const clear = company ? (["website", "linkedin", "type", "team_size", "stack", "published_email"] as const).filter((key) => {
        const old = key === "team_size" ? company.teamSize : key === "published_email" ? company.publishedEmail : company[key];
        return old !== undefined && old !== null && (Array.isArray(old) ? old.length > 0 : old !== "") && !values[key]?.trim();
      }) : [];
      const body: Record<string, unknown> = {
        ...(company ? { company_id: company.id } : { domain: (values.domain ?? "").trim() }),
        name: (values.name ?? "").trim(),
        ...(clear.length ? { clear } : {}),
      };
      for (const key of ["website", "linkedin", "type", "published_email"]) if (values[key]?.trim()) body[key] = values[key].trim();
      if (values.team_size) body.team_size = Number(values.team_size);
      if (values.stack?.trim()) body.stack = values.stack.split(",").map((part) => part.trim()).filter(Boolean);
      return api("upsert_company", body);
    }} />;
}
