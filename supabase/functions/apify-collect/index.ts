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
    // Use optimized queries per platform, ALWAYS including the original question as first query
    const getQueries = (platform: string): string[] => {
      const queries = [questionText]; // always include original
      if (optimizedQueries && optimizedQueries[platform] && optimizedQueries[platform].length > 0) {
        for (const q of optimizedQueries[platform]) {
          if (q !== questionText) queries.push(q);
        }
      }
      return queries;
    };
    const APIFY_API_KEY = Deno.env.get("APIFY_API_KEY");
    if (!APIFY_API_KEY) throw new Error("APIFY_API_KEY not configured");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const timeRangeDays = timeRange === "7d" ? 7 : timeRange === "90d" ? 90 : 30;

    const allDocuments: any[] = [];

    // Helper to collect Reddit results - sends ALL queries in one Apify call
    const fetchReddit = async (queries: string[]) => {
      const docs: any[] = [];
      try {
        console.log("Reddit: sending all queries in one call:", queries);
        const runRes = await fetch("https://api.apify.com/v2/acts/trudax~reddit-scraper-lite/run-sync-get-dataset-items?token=" + APIFY_API_KEY, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            searches: queries,
            maxItems: 50,
            sort: "relevance",
            time: timeRangeDays <= 7 ? "week" : timeRangeDays <= 30 ? "month" : "year",
          }),
        });
        if (runRes.ok) {
          const items = await runRes.json();
          console.log(`Reddit results: ${(items || []).length}`);
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
        } else { 
          const errText = await runRes.text();
          console.error("Reddit failed:", runRes.status, errText); 
        }
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

    // Helper for Substack (via Firecrawl search)
    const fetchSubstack = async (query: string) => {
      const docs: any[] = [];
      try {
        const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY");
        if (!FIRECRAWL_API_KEY) {
          console.error("FIRECRAWL_API_KEY not configured, skipping Substack");
          return docs;
        }
        const searchQuery = `site:substack.com ${query}`;
        console.log(`Substack (Firecrawl) searching: ${searchQuery}`);
        const res = await fetch("https://api.firecrawl.dev/v1/search", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${FIRECRAWL_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: searchQuery,
            limit: 15,
            scrapeOptions: { formats: ["markdown"] },
          }),
        });
        if (res.ok) {
          const data = await res.json();
          const results = data?.data || [];
          console.log(`Substack (Firecrawl) results for "${query}": ${results.length}`);
          for (const item of results) {
            const text = item.markdown || item.description || "";
            if (text.trim().length > 0) {
              docs.push({
                question_id: questionId, source: "substack",
                url: item.url || null,
                author: item.metadata?.author || item.metadata?.ogSiteName || null,
                text: text.slice(0, 2000),
                date: item.metadata?.publishedTime || null,
                engagement_metrics: {},
              });
            }
          }
        } else {
          console.error(`Substack Firecrawl failed:`, res.status, await res.text());
        }
      } catch (e) { console.error("Substack error:", e); }
      return docs;
    };

    // Run ALL queries across ALL platforms in parallel
    const tasks: Promise<any[]>[] = [];

    if (sources.includes("reddit")) {
      const queries = getQueries("reddit");
      console.log("Reddit queries:", queries);
      tasks.push(fetchReddit(queries)); // pass all queries at once
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
