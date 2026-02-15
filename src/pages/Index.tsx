import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import AppLayout from "@/components/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import StatusBadge from "@/components/StatusBadge";
import { MessageSquarePlus, Users, BarChart3, Clock } from "lucide-react";
import type { Tables } from "@/integrations/supabase/types";

type Question = Tables<"questions">;

export default function Index() {
  const { orgId, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [questions, setQuestions] = useState<Question[]>([]);
  const [memberCount, setMemberCount] = useState(0);
  const [quickAsk, setQuickAsk] = useState("");

  useEffect(() => {
    if (!orgId) return;

    supabase
      .from("questions")
      .select("*")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(10)
      .then(({ data }) => setQuestions(data || []));

    supabase
      .from("user_roles")
      .select("id", { count: "exact" })
      .eq("org_id", orgId)
      .then(({ count }) => setMemberCount(count || 0));

    // Realtime subscription for question status changes
    const channel = supabase
      .channel("questions-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "questions" }, (payload) => {
        if (payload.eventType === "UPDATE") {
          setQuestions((prev) =>
            prev.map((q) => (q.id === (payload.new as Question).id ? (payload.new as Question) : q))
          );
        } else if (payload.eventType === "INSERT") {
          setQuestions((prev) => [payload.new as Question, ...prev].slice(0, 10));
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [orgId]);

  const handleQuickAsk = () => {
    if (quickAsk.trim()) {
      navigate(`/ask?q=${encodeURIComponent(quickAsk.trim())}`);
    }
  };

  if (authLoading) return null;

  if (!orgId) {
    return (
      <div className="dark min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle>No organization</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              You're not part of an organization yet. Ask your admin for an invite or sign up with a new org.
            </p>
            <Button onClick={() => navigate("/auth")}>Go to Sign Up</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const thisMonth = questions.filter(
    (q) => new Date(q.created_at).getMonth() === new Date().getMonth()
  ).length;

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">Community sentiment at a glance</p>
        </div>

        {/* Quick ask */}
        <Card className="border-primary/20 bg-card">
          <CardContent className="pt-5 pb-4">
            <div className="flex gap-3">
              <Input
                placeholder="What do people think about...?"
                value={quickAsk}
                onChange={(e) => setQuickAsk(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleQuickAsk()}
                className="flex-1 bg-secondary/50"
              />
              <Button onClick={handleQuickAsk} className="shrink-0">
                <MessageSquarePlus className="h-4 w-4 mr-2" />
                Ask
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Stats row */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card>
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-md bg-primary/10">
                  <BarChart3 className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-semibold font-mono">{thisMonth}</p>
                  <p className="text-xs text-muted-foreground">Questions this month</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-md bg-primary/10">
                  <Users className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-semibold font-mono">{memberCount}</p>
                  <p className="text-xs text-muted-foreground">Team members</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-md bg-primary/10">
                  <Clock className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-semibold font-mono">{questions.length}</p>
                  <p className="text-xs text-muted-foreground">Total questions</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Recent questions */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Recent Questions</CardTitle>
          </CardHeader>
          <CardContent>
            {questions.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">
                No questions yet. Ask your first question above!
              </p>
            ) : (
              <div className="space-y-1">
                {questions.map((q) => (
                  <button
                    key={q.id}
                    onClick={() => navigate(`/results/${q.id}`)}
                    className="w-full flex flex-col sm:flex-row sm:items-center justify-between px-3 py-2.5 rounded-md hover:bg-secondary/50 transition-colors text-left cursor-pointer gap-1"
                  >
                    <span className="text-sm truncate">{q.question_text}</span>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-xs text-muted-foreground font-mono">
                        {new Date(q.created_at).toLocaleDateString()}
                      </span>
                      <StatusBadge status={q.status} />
                    </div>
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
