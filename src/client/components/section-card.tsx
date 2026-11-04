import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/client/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

export function SectionCard({
  title,
  count,
  icon: Icon,
  children,
  className,
  action,
}: {
  title: string;
  count?: number;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader className="flex-row items-center justify-between gap-3 border-b bg-muted/20 py-3">
        <CardTitle className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {Icon ? <Icon className="size-3.5" /> : null}
          {title}
          {count !== undefined ? <span className="rounded bg-background px-1.5 py-0.5 text-[10px] tabular-nums text-foreground">{count}</span> : null}
        </CardTitle>
        {action}
      </CardHeader>
      <CardContent className="p-0">{children}</CardContent>
    </Card>
  );
}
