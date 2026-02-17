import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { questionText, sources } = await req.json();
    if (!questionText) throw new Error("questionText required");

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const systemPrompt = `You are a question classifier and search keyword extractor for a community sentiment analysis tool.

Given a user's question, first CLASSIFY it into one of these types:
1. "standard" — Asks about sentiment/opinions on a specific topic, company, product, hobby, or anything people discuss online. Example: "How do people feel about Auth0 pricing?" or "Should I buy more pokemon cards?"
2. "comparative" — Compares two specific entities. Example: "Is WorkOS better than Auth0?" or "Stripe vs Square"
3. "abstract" — A broad or metaphorical question that CAN be reframed into searchable terms. Example: "Is software dead?" → search for "software engineering future AI"

RULES:
- NEVER classify a question as unanswerable. Every question can be searched for community opinions.
- For "standard": Extract 1-3 core search keywords (entity name + narrowing terms)
- For "comparative": Extract the two entities being compared, plus 1-2 keywords per entity
- For "abstract": Reframe into 1-3 searchable keyword phrases that would find relevant community discussions
- Keep each keyword/phrase to 1-3 words maximum
- DO NOT add generic terms like "review", "opinion", "alternative"`;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Question: "${questionText}"` },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "classify_and_extract",
              description: "Classify the question type and extract search keywords",
              parameters: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    enum: ["standard", "comparative", "abstract"],
                    description: "The classification type of the question",
                  },
                  keywords: {
                    type: "array",
                    items: { type: "string" },
                    description: "1-3 core search keywords for standard/abstract questions",
                  },
                  entity_a: {
                    type: "string",
                    description: "First entity name for comparative questions",
                  },
                  entity_b: {
                    type: "string",
                    description: "Second entity name for comparative questions",
                  },
                  entity_a_keywords: {
                    type: "array",
                    items: { type: "string" },
                    description: "1-2 search keywords for entity A in comparative questions",
                  },
                  entity_b_keywords: {
                    type: "array",
                    items: { type: "string" },
                    description: "1-2 search keywords for entity B in comparative questions",
                  },
                },
                required: ["type"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "classify_and_extract" } },
      }),
    });

    if (!response.ok) {
      console.error("AI gateway error:", response.status, await response.text());
      // Fallback: treat as standard with original question
      const queries: Record<string, string[]> = {};
      for (const s of sources) queries[s] = [questionText];
      return new Response(JSON.stringify({ type: "standard", queries }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await response.json();
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];

    if (!toolCall) {
      console.error("No tool call in response, falling back");
      const queries: Record<string, string[]> = {};
      for (const s of sources) queries[s] = [questionText];
      return new Response(JSON.stringify({ type: "standard", queries }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = JSON.parse(toolCall.function.arguments);
    console.log("Classification result:", JSON.stringify(result));

    if (result.type === "unanswerable") {
      // Treat as abstract — reframe and search anyway
      const keywords = result.keywords?.length > 0 ? result.keywords : [questionText];
      const queries: Record<string, string[]> = {};
      for (const s of sources) queries[s] = keywords;
      return new Response(JSON.stringify({ type: "abstract", queries }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }


    if (result.type === "comparative") {
      // Build separate query sets for each entity
      const queriesA: Record<string, string[]> = {};
      const queriesB: Record<string, string[]> = {};
      const kwA = result.entity_a_keywords?.length > 0 ? result.entity_a_keywords : [result.entity_a];
      const kwB = result.entity_b_keywords?.length > 0 ? result.entity_b_keywords : [result.entity_b];
      for (const s of sources) {
        queriesA[s] = kwA;
        queriesB[s] = kwB;
      }
      return new Response(JSON.stringify({
        type: "comparative",
        entity_a: result.entity_a,
        entity_b: result.entity_b,
        queries_a: queriesA,
        queries_b: queriesB,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Standard or abstract — both use keywords
    const keywords = result.keywords?.length > 0 ? result.keywords : [questionText];
    const queries: Record<string, string[]> = {};
    for (const s of sources) queries[s] = keywords;

    return new Response(JSON.stringify({ type: result.type, queries }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("optimize-queries error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
