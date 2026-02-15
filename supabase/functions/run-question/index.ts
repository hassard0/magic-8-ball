import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/** Fetch with a timeout — returns null on timeout instead of throwing */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 55000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Safe fetch that won't throw on timeout — returns a fake ok response */
async function safeFetch(url: string, init: RequestInit, label: string, timeoutMs = 50000): Promise<Response> {
  try {
    return await fetchWithTimeout(url, init, timeoutMs);
  } catch (e) {
    console.warn(`${label} timed out or failed (non-fatal):`, e);
    return new Response(JSON.stringify({ success: true, partial: true }), { status: 200 });
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

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
    await supabase.from("questions").update({ status: "running", progress_step: "Classifying question..." }).eq("id", questionId);

    // Get question details
    const { data: question, error: qErr } = await supabase
      .from("questions")
      .select("*")
      .eq("id", questionId)
      .single();

    if (qErr || !question) throw new Error("Question not found");

    // Step 0: Classify and optimize search queries via Gemini
    let classification: any = { type: "standard" };
    let optimizedQueries: Record<string, string[]> = {};

    try {
      const optimizeResponse = await fetchWithTimeout(`${supabaseUrl}/functions/v1/optimize-queries`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          questionText: question.question_text,
          sources: question.sources,
        }),
      }, 15000);

      if (optimizeResponse.ok) {
        classification = await optimizeResponse.json();
        console.log("Classification:", JSON.stringify(classification));

        // Handle unanswerable questions — mark complete with a friendly message
        if (classification.type === "unanswerable") {
          await supabase.from("analysis_results").upsert({
            question_id: questionId,
            overall_score: null,
            distribution: { positive: 0, neutral: 100, negative: 0 },
            confidence: 0,
            themes: [],
            verdict: "🎱 Can't Answer That",
            quotes: [],
            source_breakdown: {},
            // Store rejection reason in themes for display
          }, { onConflict: "question_id" });

          // Store a helpful theme explaining why
          await supabase.from("analysis_results").update({
            themes: [{ name: "Not Applicable", explanation: classification.rejection_reason || "This question isn't suited for community sentiment analysis. Try asking about a specific company, product, or technology topic." }],
          }).eq("question_id", questionId);

          await supabase.from("questions").update({ status: "complete", progress_step: null }).eq("id", questionId);
          return new Response(JSON.stringify({ success: true, type: "unanswerable" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        if (classification.type === "comparative") {
          optimizedQueries = classification.queries_a || {};
        } else {
          optimizedQueries = classification.queries || {};
        }
      } else {
        console.error("Optimize queries failed, using original question as fallback");
      }
    } catch (e) {
      console.error("Optimize queries error:", e);
    }

    if (classification.type === "comparative") {
      // === COMPARATIVE FLOW ===
      // Collect data for both entities IN PARALLEL to stay within timeout
      await supabase.from("questions").update({ progress_step: `Collecting data for ${classification.entity_a} & ${classification.entity_b}...` }).eq("id", questionId);

      const [collectA, collectB] = await Promise.all([
        safeFetch(`${supabaseUrl}/functions/v1/apify-collect`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            questionId,
            questionText: classification.entity_a,
            sources: question.sources,
            timeRange: question.time_range,
            optimizedQueries: classification.queries_a || {},
            entityTag: classification.entity_a,
          }),
        }, "Collect entity A", 50000),
        safeFetch(`${supabaseUrl}/functions/v1/apify-collect`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            questionId,
            questionText: classification.entity_b,
            sources: question.sources,
            timeRange: question.time_range,
            optimizedQueries: classification.queries_b || {},
            entityTag: classification.entity_b,
          }),
        }, "Collect entity B", 50000),
      ]);

      if (!collectA.ok) console.error("Collect entity A error:", await collectA.text());
      if (!collectB.ok) console.error("Collect entity B error:", await collectB.text());
    } else {
      // === STANDARD / ABSTRACT FLOW ===
      await supabase.from("questions").update({ progress_step: "Collecting data from sources..." }).eq("id", questionId);
      const collectResponse = await safeFetch(`${supabaseUrl}/functions/v1/apify-collect`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          questionId,
          questionText: question.question_text,
          sources: question.sources,
          timeRange: question.time_range,
          optimizedQueries,
        }),
      }, "Apify collect", 50000);

      if (!collectResponse.ok) {
        const err = await collectResponse.text();
        console.error("Apify collect error (non-fatal):", err);
        // Don't throw — proceed with whatever data was collected
      }
    }

    // Step 2: Filter irrelevant documents (skip for comparative — AI handles it during analysis)
    if (classification.type !== "comparative") {
      await supabase.from("questions").update({ progress_step: "Filtering for relevance..." }).eq("id", questionId);
      try {
        const filterResponse = await fetchWithTimeout(`${supabaseUrl}/functions/v1/filter-relevance`, {
          method: "POST",
          headers,
          body: JSON.stringify({ questionId }),
        }, 40000);

        if (filterResponse.ok) {
          const filterData = await filterResponse.json();
          console.log(`Relevance filter: kept ${filterData.kept}, removed ${filterData.removed}`);
        } else {
          console.error("Filter relevance error:", await filterResponse.text());
        }
      } catch (e) {
        console.error("Filter relevance error (non-fatal):", e);
      }
    }

    // Step 3: Analyze sentiment — fire-and-forget so we don't hit the 60s limit
    // analyze-sentiment will mark the question as complete/failed itself
    await supabase.from("questions").update({ progress_step: "Analyzing sentiment..." }).eq("id", questionId);
    const analyzeBody: any = { questionId };
    if (classification.type === "comparative") {
      analyzeBody.comparison = {
        entity_a: classification.entity_a,
        entity_b: classification.entity_b,
      };
    }

    // Fire-and-forget: don't await the response
    fetchWithTimeout(`${supabaseUrl}/functions/v1/analyze-sentiment`, {
      method: "POST",
      headers,
      body: JSON.stringify(analyzeBody),
    }, 55000).catch((err) => {
      console.error("Analyze sentiment fire-and-forget error:", err);
    });

    return new Response(JSON.stringify({ success: true, message: "Analysis handed off" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("run-question error:", error);

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
