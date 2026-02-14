import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { questionId } = await req.json();
    if (!questionId) throw new Error("questionId required");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // Mark as running
    await supabase.from("questions").update({ status: "running" }).eq("id", questionId);

    // Get question details
    const { data: question, error: qErr } = await supabase
      .from("questions")
      .select("*")
      .eq("id", questionId)
      .single();

    if (qErr || !question) throw new Error("Question not found");

    // Step 0: Optimize search queries via Gemini
    let optimizedQueries: Record<string, string[]> = {};
    try {
      const optimizeResponse = await fetch(`${supabaseUrl}/functions/v1/optimize-queries`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({
          questionText: question.question_text,
          sources: question.sources,
        }),
      });

      if (optimizeResponse.ok) {
        const optimizeData = await optimizeResponse.json();
        optimizedQueries = optimizeData.queries || {};
        console.log("Using optimized queries:", JSON.stringify(optimizedQueries));
      } else {
        console.error("Optimize queries failed, using original question as fallback");
      }
    } catch (e) {
      console.error("Optimize queries error:", e);
    }

    // Step 1: Collect data via Apify (with optimized queries)
    const collectResponse = await fetch(`${supabaseUrl}/functions/v1/apify-collect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        questionId,
        questionText: question.question_text,
        sources: question.sources,
        timeRange: question.time_range,
        optimizedQueries,
      }),
    });

    if (!collectResponse.ok) {
      const err = await collectResponse.text();
      console.error("Apify collect error:", err);
      throw new Error("Data collection failed");
    }

    // Step 2: Filter irrelevant documents
    const filterResponse = await fetch(`${supabaseUrl}/functions/v1/filter-relevance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ questionId }),
    });

    if (!filterResponse.ok) {
      const err = await filterResponse.text();
      console.error("Filter relevance error:", err);
      // Non-fatal: continue with unfiltered docs
    } else {
      const filterData = await filterResponse.json();
      console.log(`Relevance filter: kept ${filterData.kept}, removed ${filterData.removed}`);
    }

    // Step 3: Analyze sentiment
    const analyzeResponse = await fetch(`${supabaseUrl}/functions/v1/analyze-sentiment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ questionId }),
    });

    if (!analyzeResponse.ok) {
      const err = await analyzeResponse.text();
      console.error("Analyze sentiment error:", err);
      throw new Error("Sentiment analysis failed");
    }

    // Mark as complete
    await supabase.from("questions").update({ status: "complete" }).eq("id", questionId);

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("run-question error:", error);

    // Try to mark as failed
    try {
      const { questionId } = await new Response(req.body).json().catch(() => ({ questionId: null }));
      if (questionId) {
        const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
        await supabase.from("questions").update({ status: "failed" }).eq("id", questionId);
      }
    } catch {}

    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
