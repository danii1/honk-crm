import * as Dialog from "@radix-ui/react-dialog";
import { FileUp, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, listCampaigns } from "@/client/lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select } from "./ui/select";

type Report = { dry_run: boolean; total_rows: number; created: number; updated: number; unchanged: number; skipped: number; notices: string[]; rows: { row: number; action: string; label: string; reason?: string; warnings: string[] }[] };

export function ImportLeadsDialog({ onImported }: { onImported: () => void }) {
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [campaigns, setCampaigns] = useState<{ id: string; name: string }[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) listCampaigns().then(setCampaigns).catch(() => undefined); }, [open]);

  const run = async (dryRun: boolean) => {
    if (!csv.trim()) { setError("Choose a CSV file first."); return; }
    setBusy(true);
    setError(null);
    try {
      const result = await api<Report>("import_leads_csv", { csv, dry_run: dryRun, ...(campaignId && { campaign_id: campaignId }) });
      if (dryRun) setReport(result);
      else { setOpen(false); setCsv(""); setReport(null); onImported(); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not import this file."); }
    finally { setBusy(false); }
  };

  return <Dialog.Root open={open} onOpenChange={(next) => { if (!busy) { setOpen(next); setError(null); } }}>
    <Dialog.Trigger asChild><Button variant="outline" size="sm"><FileUp className="size-4" /> Import CSV</Button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/35" />
      <Dialog.Content className="fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-2xl border bg-background shadow-xl outline-none sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[min(92vw,42rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl">
        <div className="flex items-start justify-between gap-4 border-b px-5 py-4 sm:px-6">
          <div><Dialog.Title className="text-lg font-semibold">Import leads</Dialog.Title><Dialog.Description className="mt-1 text-sm text-muted-foreground">Preview matches and skipped rows before adding them.</Dialog.Description></div>
          <Dialog.Close asChild><Button variant="ghost" size="icon" aria-label="Close import"><X className="size-4" /></Button></Dialog.Close>
        </div>
        <div className="space-y-4 overflow-y-auto p-5 sm:p-6">
          <label className="block text-sm font-medium">CSV file
            <Input className="mt-1.5" type="file" accept=".csv,text/csv" onChange={async (event) => {
              const file = event.target.files?.[0];
              setReport(null);
              if (!file) { setCsv(""); setFileName(""); return; }
              if (file.size > 1_000_000) { setCsv(""); setFileName(""); setError("Choose a CSV under 1 MB, or split the file into smaller imports."); return; }
              setCsv(await file.text()); setFileName(file.name); setError(null);
            }} />
          </label>
          <label className="block text-sm font-medium">Campaign <span className="font-normal text-muted-foreground">(optional)</span>
            <div className="mt-1.5"><Select value={campaignId} onChange={(event) => { setCampaignId(event.target.value); setReport(null); }}>
              <option value="">No campaign</option>{campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}
            </Select></div>
          </label>
          {report ? <div className="rounded-lg bg-muted/50 p-4 text-sm">
            <p className="font-medium">Preview for {fileName}</p>
            <p className="mt-1 text-muted-foreground">{report.total_rows} rows · {report.created} new · {report.updated} updates · {report.unchanged} unchanged · {report.skipped} skipped</p>
            {report.notices.length ? <ul className="mt-2 list-disc pl-5 text-xs text-muted-foreground">{report.notices.map((notice) => <li key={notice}>{notice}</li>)}</ul> : null}
            {report.rows.some((row) => row.reason || row.warnings.length) ? <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto text-xs text-muted-foreground">
              {report.rows.filter((row) => row.reason || row.warnings.length).slice(0, 30).map((row) => <li key={row.row}>Row {row.row} ({row.label}): {row.reason || row.warnings.join("; ")}</li>)}
            </ul> : null}
          </div> : <p className="text-xs text-muted-foreground">Columns can include handle, name, email, company, role, source, stage, and notes. Existing identities are matched before import.</p>}
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        </div>
        <div className="flex justify-end gap-2 border-t px-5 py-3 sm:px-6">
          <Button variant="outline" disabled={busy || !csv} onClick={() => run(true)}>{busy ? "Working…" : report ? "Refresh preview" : "Preview"}</Button>
          <Button disabled={busy || !report || report.total_rows === 0} onClick={() => run(false)}>Import rows</Button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
