import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import AppLayout from "@/components/AppLayout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { Send, Loader2 } from "lucide-react";

const TIME_RANGES = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

const SOURCES = [
  { value: "reddit", label: "Reddit", icon: "🔴" },
  { value: "hackernews", label: "Hacker News", icon: "🟠" },
  { value: "substack", label: "Substack", icon: "🟣" },
];

export default function Ask() {
  const [searchParams] = useSearchParams();
  const [question, setQuestion] = useState(searchParams.get("q") || "");
  const [timeRange, setTimeRange] = useState("30d");
  const [sources, setSources] = useState<string[]>(["reddit", "hackernews", "substack"]);
  const [submitting, setSubmitting] = useState(false);
  const { user, orgId } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const toggleSource = (source: string) => {
    setSources((prev) =>
      prev.includes(source) ? prev.filter((s) => s !== source) : [...prev, source]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim() || !orgId || !user) return;
    if (sources.length === 0) {
      toast({ title: "Select at least one source", variant: "destructive" });
      return;
    }

    setSubmitting(true);
    try {
      const { data, error } = await supabase
        .from("questions")
        .insert({
          org_id: orgId,
          asked_by: user.id,
          question_text: question.trim(),
          time_range: timeRange,
          sources,
        })
        .select()
        .single();

      if (error) throw error;

      // Trigger the pipeline
      supabase.functions.invoke("run-question", {
        body: { questionId: data.id },
      });

      toast({ title: "Question submitted", description: "Analysis is running..." });
      navigate(`/results/${data.id}`);
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppLayout>
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Ask a Question</h1>
          <p className="text-sm text-muted-foreground mt-1">
            What do people think? Enter a topic and we'll analyze community sentiment.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Your Question</CardTitle>
            <CardDescription>
              Ask about any company, product, or topic to get sentiment analysis.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-2">
                <Textarea
                  placeholder="e.g. What do people think about the latest Auth0 pricing changes?"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  className="min-h-[100px] bg-secondary/30 resize-none"
                  required
                />
              </div>

              {/* Time range */}
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground uppercase tracking-wider">
                  Time Range
                </Label>
                <div className="flex gap-2">
                  {TIME_RANGES.map((tr) => (
                    <Button
                      key={tr.value}
                      type="button"
                      variant={timeRange === tr.value ? "default" : "outline"}
                      size="sm"
                      onClick={() => setTimeRange(tr.value)}
                    >
                      {tr.label}
                    </Button>
                  ))}
                </div>
              </div>

              {/* Sources */}
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground uppercase tracking-wider">
                  Sources
                </Label>
                <div className="flex gap-4">
                  {SOURCES.map((s) => (
                    <label key={s.value} className="flex items-center gap-2 cursor-pointer">
                      <Checkbox
                        checked={sources.includes(s.value)}
                        onCheckedChange={() => toggleSource(s.value)}
                      />
                      <span className="text-sm">
                        {s.icon} {s.label}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <Button type="submit" className="w-full" disabled={submitting || !question.trim()}>
                {submitting ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Send className="h-4 w-4 mr-2" />
                )}
                {submitting ? "Submitting..." : "Analyze Sentiment"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
