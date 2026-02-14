import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { questionId, questionText, sources, timeRange, optimizedQueries } = await req.json();
    // Use optimized queries per platform, falling back to original question
    const getQueries = (platform: string): string[] => {
      if (optimizedQueries && optimizedQueries[platform] && optimizedQueries[platform].length > 0) {
        return optimizedQueries[platform];
      }
      return [questionText];
    };
    const APIFY_API_KEY = Deno.env.get("APIFY_API_KEY");
    if (!APIFY_API_KEY) throw new Error("APIFY_API_KEY not configured");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const timeRangeDays = timeRange === "7d" ? 7 : timeRange === "90d" ? 90 : 30;

    const allDocuments: any[] = [];

    // Helper to collect Reddit results for a single query
    const fetchReddit = async (query: string) => {
      const docs: any[] = [];
      try {
        const runRes = await fetch("https://api.apify.com/v2/acts/trudax~reddit-scraper-lite/run-sync-get-dataset-items?token=" + APIFY_API_KEY, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            searches: [query],
            maxItems: 20,
            sort: "relevance",
            time: timeRangeDays <= 7 ? "week" : timeRangeDays <= 30 ? "month" : "year",
          }),
        });
        if (runRes.ok) {
          const items = await runRes.json();
          for (const item of items || []) {
            docs.push({
              question_id: questionId, source: "reddit",
              url: item.url || item.permalink || null,
              author: item.author || item.username || null,
              text: item.body || item.title || item.text || "",
              date: item.createdAt || item.created || null,
              engagement_metrics: { score: item.score, comments: item.numComments || item.numberOfComments },
            });
          }
        } else { console.error("Reddit failed for:", query); }
      } catch (e) { console.error("Reddit error:", e); }
      return docs;
    };

    // Helper for HN
    const fetchHN = async (query: string) => {
      const docs: any[] = [];
      try {
        const [storiesRes, commentsRes] = await Promise.all([
          fetch(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=20`),
          fetch(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=comment&hitsPerPage=30`),
        ]);
        if (storiesRes.ok) {
          const data = await storiesRes.json();
          console.log(`HN stories for "${query}": ${(data.hits || []).length}`);
          for (const hit of data.hits || []) {
            docs.push({
              question_id: questionId, source: "hackernews",
              url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
              author: hit.author || null,
              text: hit.title + (hit.story_text ? "\n" + hit.story_text.replace(/<[^>]+>/g, "") : ""),
              date: hit.created_at || null,
              engagement_metrics: { points: hit.points, comments: hit.num_comments },
            });
          }
        }
        if (commentsRes.ok) {
          const data = await commentsRes.json();
          for (const c of data.hits || []) {
            if (c.comment_text) {
              docs.push({
                question_id: questionId, source: "hackernews",
                url: `https://news.ycombinator.com/item?id=${c.objectID}`,
                author: c.author || null,
                text: c.comment_text.replace(/<[^>]+>/g, ""),
                date: c.created_at || null,
                engagement_metrics: { points: c.points || 0 },
              });
            }
          }
        }
      } catch (e) { console.error("HN error:", e); }
      return docs;
    };

    // Helper for Substack
    const fetchSubstack = async (query: string) => {
      const docs: any[] = [];
      try {
        const res = await fetch(`https://substack.com/api/v1/post/search?query=${encodeURIComponent(query)}&page=0&limit=10`);
        if (res.ok) {
          const data = await res.json();
          const posts = data.posts || data.results || data || [];
          for (const item of (Array.isArray(posts) ? posts : [])) {
            docs.push({
              question_id: questionId, source: "substack",
              url: item.canonical_url || item.url || null,
              author: item.publishedBylines?.[0]?.name || item.author?.name || item.author || null,
              text: (item.title || "") + (item.subtitle ? "\n" + item.subtitle : "") + (item.description ? "\n" + item.description : ""),
              date: item.post_date || item.publishedAt || null,
              engagement_metrics: { likes: item.reaction_count || item.reactions || 0, comments: item.comment_count || 0 },
            });
          }
        }
      } catch (e) { console.error("Substack error:", e); }
      return docs;
    };

    // Run ALL queries across ALL platforms in parallel
    const tasks: Promise<any[]>[] = [];

    if (sources.includes("reddit")) {
      const queries = getQueries("reddit");
      console.log("Reddit queries:", queries);
      // Only use first query for Reddit (Apify is slow), rest are fast APIs
      tasks.push(fetchReddit(queries[0]));
    }
    if (sources.includes("hackernews")) {
      const queries = getQueries("hackernews");
      console.log("HN queries:", queries);
      for (const q of queries) tasks.push(fetchHN(q));
    }
    if (sources.includes("substack")) {
      const queries = getQueries("substack");
      console.log("Substack queries:", queries);
      for (const q of queries) tasks.push(fetchSubstack(q));
    }

    const results = await Promise.all(tasks);
    for (const docs of results) allDocuments.push(...docs);

    // Insert documents
    if (allDocuments.length > 0) {
      const filtered = allDocuments.filter((d) => d.text && d.text.trim().length > 0);
      if (filtered.length > 0) {
        const { error } = await supabase.from("documents").insert(filtered);
        if (error) console.error("Insert documents error:", error);
      }
    }

    return new Response(JSON.stringify({ success: true, count: allDocuments.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("apify-collect error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
