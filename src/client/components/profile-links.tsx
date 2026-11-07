import { ArrowUpRight, Globe } from "lucide-react";
import type { Identity } from "@/client/lib/api";
import { cn, safeExternalUrl } from "@/client/lib/utils";
import { ChannelIcon } from "./channel-icon";

export function ProfileLinks({ identities, limit, className, showValue = false }: { identities?: Identity[]; limit?: number; className?: string; showValue?: boolean }) {
  const list = (identities ?? []).slice(0, limit);
  if (!list.length) return <span className="text-xs text-muted-foreground">No profiles</span>;
  return (
    <span className={cn("flex flex-wrap items-center gap-1", className)}>
      {list.map((i) => {
        const label = `${i.label}${i.private ? " (private)" : ""}: ${i.value}`;
        const href = safeExternalUrl(i.url);
        if (!href) {
          return (
            <span key={`${i.kind}:${i.scope ?? ""}:${i.value}`} title={label} className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">
              <ChannelIcon channel={i.channel} />
              {showValue ? i.value : null}
            </span>
          );
        }
        return (
          <a
            key={`${i.kind}:${i.scope ?? ""}:${i.value}`}
            href={href}
            target={href.startsWith("mailto:") ? undefined : "_blank"}
            rel="noreferrer noopener"
            title={label}
            aria-label={label}
            className="inline-flex items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 text-[11px] text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary"
          >
            <ChannelIcon channel={i.channel} />
            {showValue ? <span className="max-w-48 truncate">{i.value}</span> : null}
            {showValue ? <ArrowUpRight className="size-3 opacity-60" /> : null}
          </a>
        );
      })}
    </span>
  );
}

export function WebsiteLink({ url, label, className }: { url?: string | null; label?: string | null; className?: string }) {
  const href = safeExternalUrl(url);
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={cn("inline-flex items-center gap-1 text-primary hover:underline", className)}>
      <Globe className="size-3.5" />
      {label ?? href.replace(/^https?:\/\//, "")}
      <ArrowUpRight className="size-3 opacity-60" />
    </a>
  );
}
