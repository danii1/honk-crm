import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/client/lib/utils";

export const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary/10 text-primary",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-foreground",
        success: "border-transparent bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
        warning: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300",
        destructive: "border-transparent bg-destructive/12 text-destructive",
        muted: "border-transparent bg-muted text-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Badge({ className, variant, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
