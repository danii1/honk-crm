import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/client/lib/utils";
import { Card, CardContent } from "./ui/card";

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
  progress,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon;
  tone?: "default" | "good" | "warn" | "bad";
  progress?: number | null;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          {Icon ? (
            <span className={cn("rounded-md p-1.5", tone === "good" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" : tone === "warn" ? "bg-amber-500/12 text-amber-600 dark:text-amber-300" : tone === "bad" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>
              <Icon className="size-3.5" />
            </span>
          ) : null}
        </div>
        <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
        {hint ? <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div> : null}
        {progress !== undefined && progress !== null ? (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
