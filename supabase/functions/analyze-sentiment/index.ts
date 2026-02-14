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
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Get question and documents
    const { data: question } = await supabase
      .from("questions")
      .select("*")
      .eq("id", questionId)
      .single();

    const { data: documents } = await supabase
      .from("documents")
      .select("*")
      .eq("question_id", questionId);

    if (!question || !documents || documents.length === 0) {
      // No documents collected — create a neutral result
      await supabase.from("analysis_results").upsert({
        question_id: questionId,
        overall_score: 0,
        distribution: { positive: 0, neutral: 100, negative: 0 },
        confidence: 0,
        themes: [],
        verdict: "Insufficient Data",
        quotes: [],
        source_breakdown: {},
      }, { onConflict: "question_id" });

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Prepare document summaries for the AI (limit to first 100 to stay within token limits)
    const docSummaries = documents.slice(0, 100).map((d, i) =>
      `[${i + 1}] Source: ${d.source} | Author: ${d.author || "unknown"} | Date: ${d.date || "unknown"} | URL: ${d.url || "none"}\n${d.text.slice(0, 500)}`
    ).join("\n\n");

    const systemPrompt = `You are a sentiment analysis expert. Analyze the following community discussions about the question: "${question.question_text}"

CRITICAL RULES FOR QUOTES:
- You MUST select quotes from ALL source platforms present in the data (reddit, hackernews, substack, etc.), not just one.
- Each quote's "url" field MUST be copied EXACTLY from the document's URL field — do NOT fabricate or guess URLs.
- Each quote's "source" field MUST match the document's source platform name exactly.
- Select at least 3 positive, 3 neutral, and 3 negative quotes for balanced coverage.

You MUST call the "analyze_sentiment" function with your analysis results. Do not respond with plain text.`;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Here are ${documents.length} community posts/comments to analyze:\n\n${docSummaries}` },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "analyze_sentiment",
              description: "Return structured sentiment analysis results",
              parameters: {
                type: "object",
                properties: {
                  overall_score: {
                    type: "integer",
                    description: "Overall sentiment score from -100 (very negative) to +100 (very positive)",
                  },
                  distribution: {
                    type: "object",
                    properties: {
                      positive: { type: "number", description: "Percentage of positive mentions" },
                      neutral: { type: "number", description: "Percentage of neutral mentions" },
                      negative: { type: "number", description: "Percentage of negative mentions" },
                    },
                    required: ["positive", "neutral", "negative"],
                    additionalProperties: false,
                  },
                  confidence: {
                    type: "number",
                    description: "Confidence score from 0 to 1 based on volume and agreement",
                  },
                  verdict: {
                    type: "string",
                    description: "Short verdict headline like 'Mostly Negative', 'Mixed Feelings', 'Overwhelmingly Positive'",
                  },
                  themes: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        name: { type: "string" },
                        explanation: { type: "string" },
                      },
                      required: ["name", "explanation"],
                      additionalProperties: false,
                    },
                    description: "Top 3-5 themes found in the discussions",
                  },
                  quotes: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        text: { type: "string" },
                        source: { type: "string" },
                        url: { type: "string" },
                        sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
                      },
                      required: ["text", "source", "sentiment"],
                      additionalProperties: false,
                    },
                    description: "9-12 representative quotes. MUST include at least 3 positive, 3 neutral, and 3 negative quotes for balanced coverage. Pick the most insightful quote for each sentiment.",
                  },
                  source_breakdown: {
                    type: "object",
                    description: "Count of mentions per source platform",
                    additionalProperties: { type: "integer" },
                  },
                },
                required: ["overall_score", "distribution", "confidence", "verdict", "themes", "quotes", "source_breakdown"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "analyze_sentiment" } },
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        throw new Error("AI rate limit exceeded. Please try again later.");
      }
      if (response.status === 402) {
        throw new Error("AI credits depleted. Please add credits to continue.");
      }
      const errText = await response.text();
      console.error("AI gateway error:", response.status, errText);
      throw new Error("AI analysis failed");
    }

    const aiResult = await response.json();
    const toolCall = aiResult.choices?.[0]?.message?.tool_calls?.[0];

    if (!toolCall) throw new Error("AI did not return structured results");

    const analysisData = JSON.parse(toolCall.function.arguments);

    // Store results
    await supabase.from("analysis_results").upsert({
      question_id: questionId,
      overall_score: analysisData.overall_score,
      distribution: analysisData.distribution,
      confidence: analysisData.confidence,
      verdict: analysisData.verdict,
      themes: analysisData.themes,
      quotes: analysisData.quotes,
      source_breakdown: analysisData.source_breakdown,
    }, { onConflict: "question_id" });

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("analyze-sentiment error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
