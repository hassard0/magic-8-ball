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

    const systemPrompt = `You are a search query optimization expert. Given a user's question about public sentiment or opinions, generate optimized search queries for each specified platform.

Rules:
- For Reddit: Generate 2-3 search queries that would find relevant discussions. Include subreddit-specific terms if applicable. Think about how Redditors discuss topics.
- For Hacker News: Generate 2-3 search queries optimized for the tech-savvy HN audience. Use precise technical terms, company names, product names.
- For Substack: Generate 2-3 search queries that would find relevant newsletter posts and analysis pieces. Think about how writers title their articles.

Each query should be concise (2-6 words), diverse in angle, and designed to surface opinionated content rather than just informational content.`;

    const userPrompt = `Question: "${questionText}"
Platforms to optimize for: ${sources.join(", ")}

Generate optimized search queries for each platform.`;

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
          { role: "user", content: userPrompt },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "return_search_queries",
              description: "Return optimized search queries for each platform",
              parameters: {
                type: "object",
                properties: {
                  reddit: {
                    type: "array",
                    items: { type: "string" },
                    description: "Search queries optimized for Reddit",
                  },
                  hackernews: {
                    type: "array",
                    items: { type: "string" },
                    description: "Search queries optimized for Hacker News",
                  },
                  substack: {
                    type: "array",
                    items: { type: "string" },
                    description: "Search queries optimized for Substack",
                  },
                },
                required: sources,
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "return_search_queries" } },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("AI gateway error:", response.status, errText);
      // Fallback: just use the original question for all platforms
      const fallback: Record<string, string[]> = {};
      for (const s of sources) fallback[s] = [questionText];
      return new Response(JSON.stringify({ queries: fallback }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await response.json();
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];

    if (!toolCall) {
      console.error("No tool call in response, falling back");
      const fallback: Record<string, string[]> = {};
      for (const s of sources) fallback[s] = [questionText];
      return new Response(JSON.stringify({ queries: fallback }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const queries = JSON.parse(toolCall.function.arguments);
    console.log("Optimized queries:", JSON.stringify(queries));

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
