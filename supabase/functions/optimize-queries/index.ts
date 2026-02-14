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

    const systemPrompt = `You are a search keyword extractor. Given a user's question, extract 1-3 core search keywords or short phrases that identify the specific company, product, or topic being discussed.

RULES:
- Extract the SPECIFIC entity name (e.g. "Auth0", "Stripe", "Vercel")
- Add 1-2 additional terms only if they narrow the topic meaningfully (e.g. "pricing", "reliability")
- Keep each keyword/phrase to 1-3 words maximum
- These keywords will be used as simple search terms across Reddit, HN, and Substack
- DO NOT generate full questions or complex queries
- DO NOT add generic terms like "review", "opinion", "alternative"

Examples:
- "How do people feel about Auth0 pricing?" → ["Auth0", "Auth0 pricing"]
- "What's the sentiment around Vercel?" → ["Vercel"]
- "Is Stripe Connect worth using for marketplaces?" → ["Stripe Connect", "Stripe Connect marketplace"]
- "How reliable is Supabase for production?" → ["Supabase", "Supabase production"]`;

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
              name: "return_keywords",
              description: "Return 1-3 core search keywords extracted from the question",
              parameters: {
                type: "object",
                properties: {
                  keywords: {
                    type: "array",
                    items: { type: "string" },
                    description: "1-3 core search keywords or short phrases",
                  },
                },
                required: ["keywords"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "return_keywords" } },
      }),
    });

    if (!response.ok) {
      console.error("AI gateway error:", response.status, await response.text());
      // Fallback: use original question as keyword
      const queries: Record<string, string[]> = {};
      for (const s of sources) queries[s] = [questionText];
      return new Response(JSON.stringify({ queries }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await response.json();
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];

    if (!toolCall) {
      console.error("No tool call in response, falling back");
      const queries: Record<string, string[]> = {};
      for (const s of sources) queries[s] = [questionText];
      return new Response(JSON.stringify({ queries }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { keywords } = JSON.parse(toolCall.function.arguments);
    console.log("Extracted keywords:", JSON.stringify(keywords));

    // Use the same keywords for all platforms
    const queries: Record<string, string[]> = {};
    for (const s of sources) queries[s] = keywords;

    return new Response(JSON.stringify({ queries }), {
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
