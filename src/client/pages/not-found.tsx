import { SearchX } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/client/components/ui/button";
import { EmptyState } from "@/client/components/empty-state";

export function NotFoundPage() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <EmptyState
        title="Page not found"
        description="The page you are looking for does not exist or has moved."
        icon={SearchX}
        action={<Button asChild variant="outline" size="sm"><Link to="/">Back to overview</Link></Button>}
      />
    </div>
  );
}
