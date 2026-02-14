import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Database } from "@/integrations/supabase/types";

type QuestionStatus = Database["public"]["Enums"]["question_status"];

const statusConfig: Record<QuestionStatus, { label: string; className: string }> = {
  queued: { label: "Queued", className: "bg-muted text-muted-foreground border-border" },
  running: { label: "Running", className: "bg-primary/15 text-primary border-primary/30 animate-pulse" },
  complete: { label: "Complete", className: "bg-chart-positive/15 text-chart-positive border-chart-positive/30" },
  failed: { label: "Failed", className: "bg-destructive/15 text-destructive border-destructive/30" },
};

export default function StatusBadge({ status }: { status: QuestionStatus }) {
  const config = statusConfig[status];
  return (
    <Badge variant="outline" className={cn("text-xs font-mono", config.className)}>
      {config.label}
    </Badge>
  );
}
