import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  let questionId: string | undefined;
  try {
    const body = await req.json();
    questionId = body.questionId;
    const comparison = body.comparison;
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

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

      await supabase.from("questions").update({ status: "complete", progress_step: null }).eq("id", questionId);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const docSummaries = documents.slice(0, 100).map((d, i) =>
      `[${i + 1}] Source: ${d.source} | Author: ${d.author || "unknown"} | Date: ${d.date || "unknown"} | URL: ${d.url || "none"} | Entity: ${(d as any).entity_tag || "general"}\n${d.text.slice(0, 500)}`
    ).join("\n\n");

    // Choose the right analysis mode
    if (comparison) {
      const result = await runComparativeAnalysis(supabase, questionId!, question, documents, docSummaries, comparison, LOVABLE_API_KEY);
      await supabase.from("questions").update({ status: "complete", progress_step: null }).eq("id", questionId);
      return result;
    } else {
      const result = await runStandardAnalysis(supabase, questionId!, question, documents, docSummaries, LOVABLE_API_KEY);
      await supabase.from("questions").update({ status: "complete", progress_step: null }).eq("id", questionId);
      return result;
    }
  } catch (error) {
    console.error("analyze-sentiment error:", error);
    // Mark the question as failed since we own the final status now
    try {
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await supabase.from("questions").update({ status: "failed", progress_step: null }).eq("id", questionId);
    } catch (e) {
      console.error("Failed to mark question as failed:", e);
    }
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

async function runStandardAnalysis(supabase: any, questionId: string, question: any, documents: any[], docSummaries: string, LOVABLE_API_KEY: string) {
  const systemPrompt = `You are a sentiment analysis expert. Analyze the following community discussions about the question: "${question.question_text}"

USER INTENT: The user wants to understand public sentiment specifically about the topic in their question. When selecting quotes, ONLY include quotes that DIRECTLY discuss the specific company, product, or topic mentioned in the question. Discard any document or quote that merely mentions a keyword tangentially or discusses an unrelated subject.

CRITICAL RULES FOR QUOTES:
- EVERY quote MUST be directly relevant to the user's question — it should express an opinion, experience, or fact about the specific topic asked about.
- Do NOT include quotes about unrelated products, companies, or topics even if they appear in the collected data.
- You MUST select quotes from ALL source platforms present in the data (reddit, hackernews, substack, etc.), not just one.
- Each quote's "url" field MUST be copied EXACTLY from the document's URL field — do NOT fabricate or guess URLs.
- Each quote's "source" field MUST match the document's source platform name exactly.
- Select at least 3 positive, 3 neutral, and 3 negative quotes for balanced coverage.
- If there aren't enough relevant quotes for a sentiment category, include fewer rather than padding with irrelevant ones.

You MUST call the "analyze_sentiment" function with your analysis results. Do not respond with plain text.`;

  const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LOVABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
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
                overall_score: { type: "integer", description: "Overall sentiment score from -100 (very negative) to +100 (very positive)" },
                distribution: {
                  type: "object",
                  properties: {
                    positive: { type: "number" },
                    neutral: { type: "number" },
                    negative: { type: "number" },
                  },
                  required: ["positive", "neutral", "negative"],
                  additionalProperties: false,
                },
                confidence: { type: "number", description: "Confidence score from 0 to 1" },
                verdict: { type: "string", description: "Short verdict headline" },
                themes: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { name: { type: "string" }, explanation: { type: "string" } },
                    required: ["name", "explanation"],
                    additionalProperties: false,
                  },
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
                },
                source_breakdown: { type: "object", additionalProperties: { type: "integer" } },
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
    if (response.status === 429) throw new Error("AI rate limit exceeded. Please try again later.");
    if (response.status === 402) throw new Error("AI credits depleted. Please add credits to continue.");
    console.error("AI gateway error:", response.status, await response.text());
    throw new Error("AI analysis failed");
  }

  const aiResult = await response.json();
  const toolCall = aiResult.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new Error("AI did not return structured results");

  const analysisData = JSON.parse(toolCall.function.arguments);

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
}

async function runComparativeAnalysis(supabase: any, questionId: string, question: any, documents: any[], docSummaries: string, comparison: { entity_a: string; entity_b: string }, LOVABLE_API_KEY: string) {
  const systemPrompt = `You are a comparative sentiment analysis expert. The user asked: "${question.question_text}"

This is a COMPARISON between "${comparison.entity_a}" and "${comparison.entity_b}".

Analyze the community discussions and produce a side-by-side comparison. Documents may be tagged with an entity. Focus on comparing how the community feels about each entity.

CRITICAL RULES:
- Analyze sentiment for EACH entity separately
- Provide a clear comparative verdict (e.g. "Community Prefers ${comparison.entity_a}" or "Mixed — Both Have Trade-offs")
- Select quotes relevant to EACH entity
- Each quote's "url" field MUST be copied EXACTLY from the document's URL field
- Each quote's "entity" field MUST indicate which entity it's about

You MUST call the "compare_sentiment" function.`;

  const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LOVABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Here are ${documents.length} community posts/comments to analyze:\n\n${docSummaries}` },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "compare_sentiment",
            description: "Return structured comparative sentiment analysis",
            parameters: {
              type: "object",
              properties: {
                verdict: { type: "string", description: "Comparative verdict headline" },
                confidence: { type: "number", description: "Confidence score 0-1" },
                entity_a: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    score: { type: "integer", description: "Sentiment score -100 to +100" },
                    distribution: {
                      type: "object",
                      properties: {
                        positive: { type: "number" },
                        neutral: { type: "number" },
                        negative: { type: "number" },
                      },
                      required: ["positive", "neutral", "negative"],
                      additionalProperties: false,
                    },
                    strengths: {
                      type: "array",
                      items: { type: "string" },
                      description: "Top 3 strengths mentioned by community",
                    },
                    weaknesses: {
                      type: "array",
                      items: { type: "string" },
                      description: "Top 3 weaknesses mentioned by community",
                    },
                  },
                  required: ["name", "score", "distribution", "strengths", "weaknesses"],
                  additionalProperties: false,
                },
                entity_b: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    score: { type: "integer" },
                    distribution: {
                      type: "object",
                      properties: {
                        positive: { type: "number" },
                        neutral: { type: "number" },
                        negative: { type: "number" },
                      },
                      required: ["positive", "neutral", "negative"],
                      additionalProperties: false,
                    },
                    strengths: {
                      type: "array",
                      items: { type: "string" },
                    },
                    weaknesses: {
                      type: "array",
                      items: { type: "string" },
                    },
                  },
                  required: ["name", "score", "distribution", "strengths", "weaknesses"],
                  additionalProperties: false,
                },
                themes: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { name: { type: "string" }, explanation: { type: "string" } },
                    required: ["name", "explanation"],
                    additionalProperties: false,
                  },
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
                      entity: { type: "string", description: "Which entity this quote is about" },
                    },
                    required: ["text", "source", "sentiment", "entity"],
                    additionalProperties: false,
                  },
                },
                source_breakdown: { type: "object", additionalProperties: { type: "integer" } },
              },
              required: ["verdict", "confidence", "entity_a", "entity_b", "themes", "quotes", "source_breakdown"],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "compare_sentiment" } },
    }),
  });

  if (!response.ok) {
    if (response.status === 429) throw new Error("AI rate limit exceeded.");
    if (response.status === 402) throw new Error("AI credits depleted.");
    console.error("AI gateway error:", response.status, await response.text());
    throw new Error("AI analysis failed");
  }

  const aiResult = await response.json();
  const toolCall = aiResult.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new Error("AI did not return structured results");

  const compData = JSON.parse(toolCall.function.arguments);

  // Store comparison data in existing schema — use source_breakdown for comparison structure
  await supabase.from("analysis_results").upsert({
    question_id: questionId,
    overall_score: null, // No single score for comparisons
    distribution: {
      // Store both distributions
      entity_a: compData.entity_a,
      entity_b: compData.entity_b,
      is_comparison: true,
    },
    confidence: compData.confidence,
    verdict: compData.verdict,
    themes: compData.themes,
    quotes: compData.quotes,
    source_breakdown: compData.source_breakdown,
  }, { onConflict: "question_id" });

  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
