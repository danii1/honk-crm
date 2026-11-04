import { Ban, Building, LayoutDashboard, Menu, Moon, SquareKanban, Sun, UserPlus, Users } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useApp } from "../App";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./ui/dialog";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/leads", label: "Leads", icon: UserPlus, count: "lead" as const },
  { to: "/contacts", label: "Contacts", icon: Users, count: "contact" as const },
  { to: "/pipeline", label: "Pipeline", icon: SquareKanban },
  { to: "/companies", label: "Companies", icon: Building },
  { to: "/competitors", label: "Competitors", icon: Ban },
];

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("crm-theme", dark ? "dark" : "light");
    } catch {
      // ignore
    }
  }, [dark]);
  return { dark, toggle: () => setDark((d) => !d) };
}

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  const { pipeline } = useApp();
  return (
    <nav className="space-y-1">
      {NAV.map((item) => {
        const Icon = item.icon;
        const count = item.count && pipeline ? pipeline.lifecycles[item.count] : null;
        return (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive ? "bg-sidebar-accent text-foreground shadow-xs" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
              )
            }
          >
            <Icon className="size-4" />
            <span className="flex-1">{item.label}</span>
            {count !== null && count !== undefined ? (
              <Badge variant="muted" className="px-1.5 py-0 text-[10px] tabular-nums">
                {count}
              </Badge>
            ) : null}
          </NavLink>
        );
      })}
    </nav>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2 px-1">
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">O</span>
      <div className="leading-tight">
        <p className="text-sm font-semibold">Outreach CRM</p>
        <p className="text-[10px] text-muted-foreground">Sales workspace</p>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { me } = useApp();
  const { dark, toggle } = useTheme();
  const [open, setOpen] = useState(false);

  return (
    <div className="min-h-screen md:flex">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-sidebar px-3 py-4 md:flex">
        <Brand />
        <div className="mt-6 flex-1 overflow-y-auto scrollbar-thin">
          <NavItems />
        </div>
        <div className="mt-4 rounded-lg border bg-background/60 p-3">
          <p className="text-[11px] font-medium text-muted-foreground">Signed in as</p>
          <p className="mt-0.5 truncate text-xs font-medium">{me.actor.name ?? (me.actor.type === "user" ? "Your account" : "Agent")}</p>
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <Badge variant={me.role === "viewer" ? "muted" : "default"}>{me.role}</Badge>
            <span className="text-[10px] text-muted-foreground">Asia/Saigon</span>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/85 px-4 backdrop-blur md:px-6">
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation">
                <Menu className="size-5" />
              </Button>
            </DialogTrigger>
            <DialogContent aria-describedby={undefined}>
              <DialogTitle className="sr-only">Navigation</DialogTitle>
              <div className="mb-6 mt-1">
                <Brand />
              </div>
              <NavItems onNavigate={() => setOpen(false)} />
            </DialogContent>
          </Dialog>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold md:hidden">Outreach CRM</p>
            <p className="hidden text-xs text-muted-foreground md:block">
              {me.role === "viewer" ? "Read-only access" : "You can edit leads, stages and drafts"}
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={toggle} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}>
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
        </header>
        <main className="mx-auto w-full max-w-[1500px] flex-1 p-4 md:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
