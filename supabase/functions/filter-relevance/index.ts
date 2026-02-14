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

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Get question and documents
    const { data: question } = await supabase
      .from("questions")
      .select("question_text")
      .eq("id", questionId)
      .single();

    if (!question) throw new Error("Question not found");

    const { data: documents } = await supabase
      .from("documents")
      .select("id, text, source, author")
      .eq("question_id", questionId);

    if (!documents || documents.length === 0) {
      console.log("No documents to filter");
      return new Response(JSON.stringify({ success: true, kept: 0, removed: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`Filtering ${documents.length} documents for relevance to: "${question.question_text}"`);

    // Process in batches of 30 to stay within token limits
    const BATCH_SIZE = 30;
    const irrelevantIds: string[] = [];

    for (let i = 0; i < documents.length; i += BATCH_SIZE) {
      const batch = documents.slice(i, i + BATCH_SIZE);

      const docList = batch.map((d, idx) =>
        `[${idx + 1}] (uuid: ${d.id}) Source: ${d.source} | Author: ${d.author || "unknown"}\n${d.text.slice(0, 200)}`
      ).join("\n\n");

      const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash-lite",
          messages: [
            {
              role: "system",
              content: `You are a relevance filter. The user asked: "${question.question_text}"

For each document below, determine if it is RELEVANT to this question.
A document is relevant if it directly discusses the specific company/product/topic.
A document is NOT relevant if it only mentions the topic tangentially or is about something else.

Return the UUIDs (the "uuid" field) of documents that are NOT relevant. Return ONLY valid UUIDs, not index numbers.`,
            },
            { role: "user", content: docList },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "mark_irrelevant",
                description: "Return the IDs of documents that are NOT relevant to the question",
                parameters: {
                  type: "object",
                  properties: {
                    irrelevant_ids: {
                      type: "array",
                      items: { type: "string" },
                      description: "Array of document IDs that are NOT relevant",
                    },
                  },
                  required: ["irrelevant_ids"],
                  additionalProperties: false,
                },
              },
            },
          ],
          tool_choice: { type: "function", function: { name: "mark_irrelevant" } },
        }),
      });

      if (!response.ok) {
        console.error(`Relevance filter batch ${i / BATCH_SIZE + 1} failed:`, response.status);
        continue; // Skip this batch rather than failing entirely
      }

      const data = await response.json();
      const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
      if (toolCall) {
        const result = JSON.parse(toolCall.function.arguments);
        if (result.irrelevant_ids?.length > 0) {
          // Filter to only valid UUIDs
          const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          const validIds = result.irrelevant_ids.filter((id: string) => uuidRegex.test(id));
          irrelevantIds.push(...validIds);
        }
      }
    }

    // Delete irrelevant documents
    if (irrelevantIds.length > 0) {
      const { error } = await supabase
        .from("documents")
        .delete()
        .in("id", irrelevantIds);

      if (error) {
        console.error("Failed to delete irrelevant docs:", error);
      } else {
        console.log(`Removed ${irrelevantIds.length} irrelevant documents, kept ${documents.length - irrelevantIds.length}`);
      }
    } else {
      console.log(`All ${documents.length} documents deemed relevant`);
    }

    return new Response(
      JSON.stringify({
        success: true,
        kept: documents.length - irrelevantIds.length,
        removed: irrelevantIds.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("filter-relevance error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
