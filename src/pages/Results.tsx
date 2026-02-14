import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import AppLayout from "@/components/AppLayout";
import StatusBadge from "@/components/StatusBadge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, ExternalLink, TrendingUp, TrendingDown, Minus, Shield, MessageSquare, Hash, RotateCcw, Trash2, Search, Filter, BarChart3, Brain } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { PieChart, Pie, Cell, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip } from "recharts";
import type { Tables, Json } from "@/integrations/supabase/types";

type Question = Tables<"questions">;
type AnalysisResult = Tables<"analysis_results">;
type Document = Tables<"documents">;

interface Distribution { positive: number; neutral: number; negative: number }
interface Theme { name: string; explanation: string }
interface Quote { text: string; source: string; url?: string; sentiment: string }

export default function Results() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [question, setQuestion] = useState<Question | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [rerunning, setRerunning] = useState(false);
  const { toast } = useToast();
  useEffect(() => {
    if (!id) return;

    const fetchData = async () => {
      const [qRes, aRes, dRes] = await Promise.all([
        supabase.from("questions").select("*").eq("id", id).single(),
        supabase.from("analysis_results").select("*").eq("question_id", id).maybeSingle(),
        supabase.from("documents").select("*").eq("question_id", id).order("created_at", { ascending: false }),
      ]);
      setQuestion(qRes.data);
      setAnalysis(aRes.data);
      setDocuments(dRes.data || []);
      setLoading(false);
    };

    fetchData();

    // Poll for running questions
    const channel = supabase
      .channel(`question-${id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "questions", filter: `id=eq.${id}` }, (payload) => {
        setQuestion(payload.new as Question);
        if ((payload.new as Question).status === "complete") {
          // Refetch analysis
          supabase.from("analysis_results").select("*").eq("question_id", id).maybeSingle()
            .then(({ data }) => setAnalysis(data));
          supabase.from("documents").select("*").eq("question_id", id)
            .then(({ data }) => setDocuments(data || []));
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [id]);

  const handleRerun = async () => {
    if (!question || !id) return;
    setRerunning(true);
    try {
      // Delete old results and documents
      await Promise.all([
        supabase.from("analysis_results").delete().eq("question_id", id),
        supabase.from("documents").delete().eq("question_id", id),
      ]);
      setAnalysis(null);
      setDocuments([]);

      // Reset status to queued
      await supabase.from("questions").update({ status: "queued" }).eq("id", id);
      setQuestion((prev) => prev ? { ...prev, status: "queued" } : prev);

      // Trigger run-question
      const { error } = await supabase.functions.invoke("run-question", {
        body: { questionId: id },
      });
      if (error) throw error;
      toast({ title: "Re-running analysis", description: "Collecting fresh data and analyzing..." });
    } catch (err) {
      console.error("Rerun error:", err);
      toast({ title: "Error", description: "Failed to re-run. Please try again.", variant: "destructive" });
    } finally {
      setRerunning(false);
    }
  };

  const handleDelete = async () => {
    if (!id) return;
    try {
      await Promise.all([
        supabase.from("analysis_results").delete().eq("question_id", id),
        supabase.from("documents").delete().eq("question_id", id),
      ]);
      await supabase.from("questions").delete().eq("id", id);
      toast({ title: "Deleted", description: "Question and results removed." });
      navigate("/");
    } catch (err) {
      console.error("Delete error:", err);
      toast({ title: "Error", description: "Failed to delete.", variant: "destructive" });
    }
  };

  if (loading) {
    return (
      <AppLayout>
        <div className="space-y-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-32 w-full" />
          <div className="grid grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-24" />)}
          </div>
        </div>
      </AppLayout>
    );
  }

  if (!question) {
    return (
      <AppLayout>
        <p className="text-muted-foreground">Question not found.</p>
      </AppLayout>
    );
  }

  const dist = (analysis?.distribution as unknown as Distribution) || { positive: 0, neutral: 0, negative: 0 };
  const themes = (analysis?.themes as unknown as Theme[]) || [];
  const quotes = (analysis?.quotes as unknown as Quote[]) || [];
  const aiSourceBreakdown = (analysis?.source_breakdown as unknown as Record<string, number>) || {};
  
  // Compute source breakdown from actual documents if AI didn't provide it
  const sourceBreakdown = Object.keys(aiSourceBreakdown).length > 0
    ? aiSourceBreakdown
    : documents.reduce<Record<string, number>>((acc, doc) => {
        acc[doc.source] = (acc[doc.source] || 0) + 1;
        return acc;
      }, {});

  const pieData = [
    { name: "Positive", value: dist.positive, color: "hsl(var(--chart-positive))" },
    { name: "Neutral", value: dist.neutral, color: "hsl(var(--chart-neutral))" },
    { name: "Negative", value: dist.negative, color: "hsl(var(--chart-negative))" },
  ];

  const barData = Object.entries(sourceBreakdown).map(([name, count]) => ({ name, count }));

  const getScoreColor = (score: number | null) => {
    if (score === null) return "text-muted-foreground";
    if (score > 20) return "text-chart-positive";
    if (score < -20) return "text-destructive";
    return "text-chart-neutral";
  };

  const getScoreIcon = (score: number | null) => {
    if (score === null) return Minus;
    if (score > 20) return TrendingUp;
    if (score < -20) return TrendingDown;
    return Minus;
  };

  const ScoreIcon = getScoreIcon(analysis?.overall_score ?? null);

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* Back & title */}
        <div className="flex items-center gap-3">
          <Button variant="outline" size="icon" onClick={() => navigate(-1)} className="shrink-0">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-semibold tracking-tight text-foreground">{question.question_text}</h1>
            <div className="flex items-center gap-2 mt-1">
              <StatusBadge status={question.status} />
              <span className="text-xs text-muted-foreground font-mono">
                {new Date(question.created_at).toLocaleString()}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {(question.status === "complete" || question.status === "failed") && (
              <Button variant="secondary" size="sm" onClick={handleRerun} disabled={rerunning}>
                <RotateCcw className={`h-4 w-4 mr-1.5 ${rerunning ? "animate-spin" : ""}`} />
                {rerunning ? "Re-running…" : "Re-run"}
              </Button>
            )}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" className="text-destructive hover:text-destructive">
                  <Trash2 className="h-4 w-4 mr-1.5" />
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this question?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete the question, all collected data, and analysis results.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        {question.status !== "complete" ? (
          <Card>
            <CardContent className="py-12 text-center space-y-6">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary/10 animate-pulse-glow mb-2">
                <span className="text-2xl">🎱</span>
              </div>
              {question.status === "failed" ? (
                <p className="text-sm text-muted-foreground">Analysis failed. Please try again.</p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    {(question as any).progress_step || (question.status === "queued" ? "Your question is queued..." : "Processing...")}
                  </p>
                  <div className="max-w-xs mx-auto space-y-3">
                    {[
                      { icon: Search, label: "Extract keywords", step: "Extracting" },
                      { icon: BarChart3, label: "Collect data", step: "Collecting" },
                      { icon: Filter, label: "Filter relevance", step: "Filtering" },
                      { icon: Brain, label: "Analyze sentiment", step: "Analyzing" },
                    ].map(({ icon: Icon, label, step }, i) => {
                      const progressStep = (question as any).progress_step || "";
                      const isActive = progressStep.toLowerCase().includes(step.toLowerCase());
                      const stepOrder = ["Extracting", "Collecting", "Filtering", "Analyzing"];
                      const currentIdx = stepOrder.findIndex(s => progressStep.toLowerCase().includes(s.toLowerCase()));
                      const isDone = currentIdx > i;
                      return (
                        <div key={i} className={`flex items-center gap-3 text-sm transition-all ${isActive ? "text-primary font-medium" : isDone ? "text-muted-foreground" : "text-muted-foreground/40"}`}>
                          <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${isActive ? "bg-primary/15 animate-pulse" : isDone ? "bg-primary/10" : "bg-muted"}`}>
                            <Icon className="h-3 w-3" />
                          </div>
                          <span>{label}</span>
                          {isDone && <span className="ml-auto text-xs text-chart-positive">✓</span>}
                          {isActive && <span className="ml-auto text-xs text-primary animate-pulse">●</span>}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        ) : analysis ? (
          <>
            {/* Verdict banner */}
            <Card className="border-primary/30 bg-gradient-to-r from-primary/5 to-transparent">
              <CardContent className="py-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <span className="text-4xl">🎱</span>
                    <div>
                      <p className="text-xs text-muted-foreground uppercase tracking-wider">Verdict</p>
                      <p className="text-2xl font-bold tracking-tight">{analysis.verdict || "N/A"}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">Score</p>
                    <p className={`text-3xl font-mono font-bold ${getScoreColor(analysis.overall_score)}`}>
                      <ScoreIcon className="inline h-5 w-5 mr-1" />
                      {analysis.overall_score ?? "—"}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Metrics row */}
            <div className="grid grid-cols-4 gap-4">
              <Card>
                <CardContent className="pt-4 pb-3">
                  <p className="text-xs text-muted-foreground">Confidence</p>
                  <p className="text-xl font-mono font-semibold">
                    {analysis.confidence ? `${Math.round(Number(analysis.confidence) * 100)}%` : "—"}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-3">
                  <p className="text-xs text-muted-foreground">Mentions</p>
                  <p className="text-xl font-mono font-semibold">{documents.length}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-3">
                  <p className="text-xs text-muted-foreground">Sources</p>
                  <p className="text-xl font-mono font-semibold">{Object.keys(sourceBreakdown).length}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-3">
                  <p className="text-xs text-muted-foreground">Themes</p>
                  <p className="text-xl font-mono font-semibold">{themes.length}</p>
                </CardContent>
              </Card>
            </div>

            {/* Charts */}
            <div className="grid grid-cols-2 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Sentiment Distribution</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-48">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={pieData} cx="50%" cy="50%" innerRadius={40} outerRadius={70} dataKey="value" strokeWidth={0}>
                          {pieData.map((entry, i) => (
                            <Cell key={i} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="flex justify-center gap-4 mt-2">
                    {pieData.map((d) => (
                      <div key={d.name} className="flex items-center gap-1.5 text-xs">
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: d.color }} />
                        {d.name} ({d.value}%)
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Source Breakdown</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-48">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={barData}>
                        <XAxis dataKey="name" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                        <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                        <Tooltip />
                        <Bar dataKey="count" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Themes */}
            {themes.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Top Themes</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {themes.map((t, i) => (
                    <div key={i} className="flex gap-3 p-3 rounded-md bg-secondary/30">
                      <Hash className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-medium">{t.name}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{t.explanation}</p>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Quotes */}
            {quotes.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Representative Quotes</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {quotes.map((q, i) => (
                    <div key={i} className="p-3 rounded-md bg-secondary/30 border-l-2 border-primary/50">
                      <p className="text-sm italic">"{q.text}"</p>
                      <div className="flex items-center gap-2 mt-2">
                        <Badge variant="outline" className="text-xs">
                          {q.source}
                        </Badge>
                        <Badge
                          variant="outline"
                          className={`text-xs ${
                            q.sentiment === "positive"
                              ? "text-chart-positive border-chart-positive/30"
                              : q.sentiment === "negative"
                              ? "text-destructive border-destructive/30"
                              : "text-chart-neutral border-chart-neutral/30"
                          }`}
                        >
                          {q.sentiment}
                        </Badge>
                        {q.url && (
                          <a href={q.url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline flex items-center gap-1">
                            <ExternalLink className="h-3 w-3" /> Source
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Raw sources */}
            {documents.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">
                    Raw Sources ({documents.length})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="max-h-64 overflow-y-auto space-y-2">
                    {documents.map((doc) => (
                      <div key={doc.id} className="flex items-start gap-3 p-2 rounded text-xs hover:bg-secondary/30">
                        <Badge variant="outline" className="shrink-0 mt-0.5">{doc.source}</Badge>
                        <p className="text-muted-foreground truncate flex-1">{doc.text}</p>
                        {doc.url && (
                          <a href={doc.url} target="_blank" rel="noopener noreferrer" className="text-primary shrink-0">
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        ) : (
          <Card>
            <CardContent className="py-8 text-center">
              <p className="text-sm text-muted-foreground">No analysis results available.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </AppLayout>
  );
}
