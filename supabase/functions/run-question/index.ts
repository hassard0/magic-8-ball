import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/** Fetch with a timeout (default 55s to stay under edge function 60s limit) */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 55000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Parse body early so we can reference questionId in the error handler
  let questionId: string | null = null;

  try {
    const body = await req.json();
    questionId = body.questionId;
    if (!questionId) throw new Error("questionId required");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceKey}`,
    };

    // Mark as running
    await supabase.from("questions").update({ status: "running", progress_step: "Extracting search keywords..." }).eq("id", questionId);

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
      const optimizeResponse = await fetchWithTimeout(`${supabaseUrl}/functions/v1/optimize-queries`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          questionText: question.question_text,
          sources: question.sources,
        }),
      }, 15000); // 15s max for keyword extraction

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
    await supabase.from("questions").update({ progress_step: "Collecting data from sources..." }).eq("id", questionId);
    const collectResponse = await fetchWithTimeout(`${supabaseUrl}/functions/v1/apify-collect`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        questionId,
        questionText: question.question_text,
        sources: question.sources,
        timeRange: question.time_range,
        optimizedQueries,
      }),
    }, 50000); // 50s for data collection

    if (!collectResponse.ok) {
      const err = await collectResponse.text();
      console.error("Apify collect error:", err);
      throw new Error("Data collection failed");
    }

    // Step 2: Filter irrelevant documents
    await supabase.from("questions").update({ progress_step: "Filtering for relevance..." }).eq("id", questionId);
    try {
      const filterResponse = await fetchWithTimeout(`${supabaseUrl}/functions/v1/filter-relevance`, {
        method: "POST",
        headers,
        body: JSON.stringify({ questionId }),
      }, 50000);

      if (filterResponse.ok) {
        const filterData = await filterResponse.json();
        console.log(`Relevance filter: kept ${filterData.kept}, removed ${filterData.removed}`);
      } else {
        console.error("Filter relevance error:", await filterResponse.text());
      }
    } catch (e) {
      console.error("Filter relevance error (non-fatal):", e);
      // Non-fatal: continue with unfiltered docs
    }

    // Step 3: Analyze sentiment
    await supabase.from("questions").update({ progress_step: "Analyzing sentiment..." }).eq("id", questionId);
    const analyzeResponse = await fetchWithTimeout(`${supabaseUrl}/functions/v1/analyze-sentiment`, {
      method: "POST",
      headers,
      body: JSON.stringify({ questionId }),
    }, 55000);

    if (!analyzeResponse.ok) {
      const err = await analyzeResponse.text();
      console.error("Analyze sentiment error:", err);
      throw new Error("Sentiment analysis failed");
    }

    // Mark as complete
    await supabase.from("questions").update({ status: "complete", progress_step: null }).eq("id", questionId);

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("run-question error:", error);

    // Mark as failed using the questionId we parsed at the top
    if (questionId) {
      try {
        const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
        await supabase.from("questions").update({ status: "failed", progress_step: null }).eq("id", questionId);
      } catch (e) {
        console.error("Failed to mark question as failed:", e);
      }
    }

    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
