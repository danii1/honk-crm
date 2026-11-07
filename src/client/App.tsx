import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { getMe, getPipeline, type Me, type PipelineSummary } from "./lib/api";
import { AppShell } from "./components/app-shell";
import { OverviewPage } from "./pages/overview";
import { ContactsPage } from "./pages/contacts";
import { ContactDetailPage } from "./pages/contact-detail";
import { PipelinePage } from "./pages/pipeline";
import { CompaniesPage } from "./pages/companies";
import { CompetitorsPage } from "./pages/competitors";
import { NotFoundPage } from "./pages/not-found";

interface AppContextValue {
  me: Me;
  pipeline: PipelineSummary | null;
  refreshPipeline: () => void;
  canWrite: boolean;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [pipeline, setPipeline] = useState<PipelineSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshPipeline = useCallback(() => {
    getPipeline().then(setPipeline).catch(() => undefined);
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.all([getMe(), getPipeline()])
      .then(([m, p]) => {
        if (!alive) return;
        setMe(m);
        setPipeline(p);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-md rounded-xl border bg-card p-6 text-center shadow-sm">
          <p className="text-sm font-medium">Could not load the CRM</p>
          <p className="mt-1 text-xs text-muted-foreground">{error}</p>
          <button className="mt-4 text-sm font-medium text-primary hover:underline" onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!me) return <BootSkeleton />;

  const canWrite = me.role !== "viewer" && me.scopes.includes("crm:write");

  return (
    <AppContext.Provider value={{ me, pipeline, refreshPipeline, canWrite }}>
      <AppShell>
        <Routes>
          <Route index element={<OverviewPage />} />
          <Route path="leads" element={<ContactsPage lifecycle="lead" />} />
          <Route path="contacts" element={<ContactsPage lifecycle="contact" />} />
          <Route path="pipeline" element={<PipelinePage />} />
          <Route path="companies" element={<CompaniesPage />} />
          <Route path="competitors" element={<CompetitorsPage />} />
          <Route path="leads/:id" element={<ContactDetailPage />} />
          <Route path="contacts/:id" element={<ContactDetailPage />} />
          <Route path="*" element={<NotFoundPage />} />
          <Route path="home" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
    </AppContext.Provider>
  );
}

function BootSkeleton() {
  return (
    <div className="flex min-h-screen">
      <div className="hidden w-64 border-r bg-sidebar p-4 md:block">
        <div className="h-8 w-40 animate-pulse rounded-md bg-muted" />
        <div className="mt-8 space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-8 animate-pulse rounded-md bg-muted" />
          ))}
        </div>
      </div>
      <div className="flex-1 p-6">
        <div className="h-8 w-56 animate-pulse rounded-md bg-muted" />
        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      </div>
    </div>
  );
}
