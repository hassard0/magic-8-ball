import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import AppLayout from "@/components/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import StatusBadge from "@/components/StatusBadge";
import { Search } from "lucide-react";
import type { Tables } from "@/integrations/supabase/types";

type Question = Tables<"questions">;

export default function HistoryPage() {
  const { orgId } = useAuth();
  const navigate = useNavigate();
  const [questions, setQuestions] = useState<Question[]>([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!orgId) return;
    supabase
      .from("questions")
      .select("*")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .then(({ data }) => setQuestions(data || []));
  }, [orgId]);

  const filtered = questions.filter((q) =>
    q.question_text.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <AppLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">History</h1>
          <p className="text-sm text-muted-foreground mt-1">All past sentiment analyses</p>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search questions..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 bg-secondary/30"
          />
        </div>

        <Card>
          <CardContent className="p-0">
            {filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">No questions found.</p>
            ) : (
              <div className="divide-y divide-border">
                {filtered.map((q) => (
                  <button
                    key={q.id}
                    onClick={() => navigate(`/results/${q.id}`)}
                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-secondary/30 transition-colors text-left"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm truncate">{q.question_text}</p>
                      <div className="flex flex-wrap items-center gap-2 mt-1">
                        <span className="text-xs text-muted-foreground font-mono">
                          {new Date(q.created_at).toLocaleString()}
                        </span>
                        <span className="text-xs text-muted-foreground">•</span>
                        <span className="text-xs text-muted-foreground">{q.time_range}</span>
                        <span className="text-xs text-muted-foreground">•</span>
                        <span className="text-xs text-muted-foreground">{q.sources.join(", ")}</span>
                      </div>
                    </div>
                    <StatusBadge status={q.status} />
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
