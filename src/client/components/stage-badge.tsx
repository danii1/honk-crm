import type { VariantProps } from "class-variance-authority";
import { Badge, badgeVariants } from "./ui/badge";
import { titleCase } from "@/client/lib/utils";

type Variant = VariantProps<typeof badgeVariants>["variant"];

const VARIANTS: Record<string, Variant> = {
  new: "muted",
  qualified: "outline",
  drafted: "warning",
  contacted: "secondary",
  connection_pending: "secondary",
  connected: "success",
  responded: "default",
  call_booked: "success",
  pilot: "success",
  paying: "success",
  lost: "destructive",
  do_not_contact: "destructive",
};

export function StageBadge({ stage, className }: { stage: string; className?: string }) {
  return (
    <Badge variant={VARIANTS[stage] ?? "outline"} className={className}>
      {titleCase(stage)}
    </Badge>
  );
}

export function LifecycleBadge({ lifecycle }: { lifecycle: "lead" | "contact" | "archived" }) {
  if (lifecycle === "contact") return <Badge variant="success">Contact</Badge>;
  if (lifecycle === "archived") return <Badge variant="muted">Archived</Badge>;
  return <Badge variant="outline">Lead</Badge>;
}
