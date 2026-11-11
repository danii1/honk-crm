import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/client/components/ui/button";
import { Input } from "@/client/components/ui/input";
import { Select } from "@/client/components/ui/select";
import { cn } from "@/client/lib/utils";

export type FormField = {
  name: string;
  label: string;
  type?: "text" | "email" | "url" | "number" | "date" | "datetime-local" | "textarea" | "select";
  value?: string | number | null;
  placeholder?: string;
  help?: string;
  required?: boolean;
  readOnly?: boolean;
  full?: boolean;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
};

export function RecordFormDialog({ trigger, title, description, fields, submitLabel = "Save", onSave, onSaved, open, onOpenChange }: {
  trigger?: ReactNode;
  title: string;
  description?: string;
  fields: FormField[];
  submitLabel?: string;
  onSave: (values: Record<string, string>) => Promise<unknown>;
  onSaved?: (result: unknown) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isOpen = open ?? internalOpen;
  const setOpen = (next: boolean) => {
    if (busy) return;
    setError(null);
    onOpenChange?.(next);
    if (open === undefined) setInternalOpen(next);
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={setOpen}>
      {trigger ? <Dialog.Trigger asChild>{trigger}</Dialog.Trigger> : null}
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/35" />
        <Dialog.Content className="fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-2xl border bg-background shadow-xl outline-none sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[min(92vw,42rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl">
          <div className="flex items-start justify-between gap-4 border-b px-5 py-4 sm:px-6">
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-semibold tracking-tight">{title}</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-muted-foreground">{description ?? "Update this record in Honk."}</Dialog.Description>
            </div>
            <Dialog.Close asChild><Button type="button" variant="ghost" size="icon" aria-label="Close form"><X className="size-4" /></Button></Dialog.Close>
          </div>
          <form
            className="flex min-h-0 flex-col"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError(null);
              const values = Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<string, string>;
              try {
                const result = await onSave(values);
                setBusy(false);
                setOpen(false);
                onSaved?.(result);
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "Could not save. Please try again.");
                setBusy(false);
              }
            }}
          >
            <div className="grid min-h-0 grid-cols-1 gap-x-4 gap-y-4 overflow-y-auto px-5 py-5 sm:grid-cols-2 sm:px-6">
              {fields.map((field) => (
                <label key={field.name} className={cn("block min-w-0 text-sm", field.full && "sm:col-span-2")}>
                  <span className="mb-1.5 block font-medium">{field.label}{field.required ? <span className="ml-1 text-destructive">*</span> : null}</span>
                  {field.type === "textarea" ? (
                    <textarea name={field.name} defaultValue={field.value ?? ""} required={field.required} placeholder={field.placeholder} rows={4}
                      className="flex w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
                  ) : field.type === "select" ? (
                    <Select name={field.name} defaultValue={field.value ?? ""} required={field.required}>
                      {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </Select>
                  ) : (
                    <Input name={field.name} type={field.type ?? "text"} defaultValue={field.value ?? ""} required={field.required} readOnly={field.readOnly} placeholder={field.placeholder} min={field.min} max={field.max} />
                  )}
                  {field.help ? <span className="mt-1 block text-xs text-muted-foreground">{field.help}</span> : null}
                </label>
              ))}
            </div>
            <div className="flex items-center justify-between gap-4 border-t px-5 py-3 sm:px-6">
              <p role="alert" className="min-w-0 text-xs text-destructive">{error}</p>
              <div className="ml-auto flex shrink-0 gap-2">
                <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={busy}>{busy ? "Saving…" : submitLabel}</Button>
              </div>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
