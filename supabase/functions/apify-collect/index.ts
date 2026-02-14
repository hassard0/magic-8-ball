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

    // Reddit search via Apify
    if (sources.includes("reddit")) {
      const redditQueries = getQueries("reddit");
      console.log("Reddit queries:", redditQueries);
      for (const query of redditQueries) {
        try {
          const runRes = await fetch("https://api.apify.com/v2/acts/trudax~reddit-scraper-lite/run-sync-get-dataset-items?token=" + APIFY_API_KEY, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              searches: [query],
              maxItems: 30,
              sort: "relevance",
              time: timeRangeDays <= 7 ? "week" : timeRangeDays <= 30 ? "month" : "year",
            }),
          });

          if (runRes.ok) {
            const items = await runRes.json();
            for (const item of items || []) {
              allDocuments.push({
                question_id: questionId,
                source: "reddit",
                url: item.url || item.permalink || null,
                author: item.author || item.username || null,
                text: item.body || item.title || item.text || "",
                date: item.createdAt || item.created || null,
                engagement_metrics: { score: item.score, comments: item.numComments || item.numberOfComments },
              });
            }
          } else {
            console.error("Reddit scrape failed for query:", query, await runRes.text());
          }
        } catch (e) { console.error("Reddit error:", e); }
      }
    }

    // Hacker News search via Algolia API
    if (sources.includes("hackernews")) {
      const hnQueries = getQueries("hackernews");
      console.log("HN queries:", hnQueries);
      for (const query of hnQueries) {
        try {
          const hnRes = await fetch(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=30`);
          if (hnRes.ok) {
            const hnData = await hnRes.json();
            console.log(`HN stories for "${query}": ${(hnData.hits || []).length}`);
            for (const hit of hnData.hits || []) {
              allDocuments.push({
                question_id: questionId,
                source: "hackernews",
                url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
                author: hit.author || null,
                text: hit.title + (hit.story_text ? "\n" + hit.story_text.replace(/<[^>]+>/g, "") : ""),
                date: hit.created_at || null,
                engagement_metrics: { points: hit.points, comments: hit.num_comments },
              });
            }

            const commentsRes = await fetch(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=comment&hitsPerPage=50`);
            if (commentsRes.ok) {
              const commentsData = await commentsRes.json();
              for (const comment of commentsData.hits || []) {
                if (comment.comment_text) {
                  allDocuments.push({
                    question_id: questionId,
                    source: "hackernews",
                    url: `https://news.ycombinator.com/item?id=${comment.objectID}`,
                    author: comment.author || null,
                    text: comment.comment_text.replace(/<[^>]+>/g, ""),
                    date: comment.created_at || null,
                    engagement_metrics: { points: comment.points || 0 },
                  });
                }
              }
            }
          }
        } catch (e) { console.error("HN error:", e); }
      }
    }

    // Substack search
    if (sources.includes("substack")) {
      const substackQueries = getQueries("substack");
      console.log("Substack queries:", substackQueries);
      for (const query of substackQueries) {
        try {
          const searchRes = await fetch(`https://substack.com/api/v1/post/search?query=${encodeURIComponent(query)}&page=0&limit=15`);
          if (searchRes.ok) {
            const searchData = await searchRes.json();
            const posts = searchData.posts || searchData.results || searchData || [];
            for (const item of (Array.isArray(posts) ? posts : [])) {
              allDocuments.push({
                question_id: questionId,
                source: "substack",
                url: item.canonical_url || item.url || null,
                author: item.publishedBylines?.[0]?.name || item.author?.name || item.author || null,
                text: (item.title || "") + (item.subtitle ? "\n" + item.subtitle : "") + (item.description ? "\n" + item.description : ""),
                date: item.post_date || item.publishedAt || null,
                engagement_metrics: { likes: item.reaction_count || item.reactions || 0, comments: item.comment_count || 0 },
              });
            }
          }
        } catch (e) { console.error("Substack error:", e); }
      }
    }

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
