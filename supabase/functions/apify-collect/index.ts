import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/** Wrap a fetch with a per-source timeout so one slow source can't block everything */
function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 25000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/** Wrap a source task with a timeout — returns empty array on timeout instead of failing */
function withSourceTimeout<T>(promise: Promise<T[]>, label: string, timeoutMs = 30000): Promise<T[]> {
  return Promise.race([
    promise,
    new Promise<T[]>((resolve) => {
      setTimeout(() => {
        console.warn(`${label}: timed out after ${timeoutMs / 1000}s, skipping`);
        resolve([]);
      }, timeoutMs);
    }),
  ]);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { questionId, questionText, sources, timeRange, optimizedQueries, entityTag } = await req.json();
    // Use extracted keywords per platform — these are focused 1-3 word terms
    const getQueries = (platform: string): string[] => {
      if (optimizedQueries && optimizedQueries[platform] && optimizedQueries[platform].length > 0) {
        return optimizedQueries[platform];
      }
      return [questionText]; // fallback to original question
    };
    const APIFY_API_KEY = Deno.env.get("APIFY_API_KEY");
    if (!APIFY_API_KEY) throw new Error("APIFY_API_KEY not configured");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const timeRangeDays = timeRange === "7d" ? 7 : timeRange === "90d" ? 90 : timeRange === "180d" ? 180 : timeRange === "1y" ? 365 : 30;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - timeRangeDays);
    const cutoffTimestamp = Math.floor(cutoffDate.getTime() / 1000);

    const allDocuments: any[] = [];

    // Helper to collect Reddit results - sends ALL queries in one Apify call
    const fetchReddit = async (queries: string[]) => {
      const docs: any[] = [];
      try {
        console.log("Reddit: sending all queries in one call:", queries);
        const runRes = await fetchWithTimeout("https://api.apify.com/v2/acts/trudax~reddit-scraper-lite/run-sync-get-dataset-items?token=" + APIFY_API_KEY, {
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
        const dateFilter = `created_at_i>${cutoffTimestamp}`;
        const [storiesRes, commentsRes] = await Promise.all([
          fetch(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&numericFilters=${dateFilter}&hitsPerPage=20`),
          fetch(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=comment&numericFilters=${dateFilter}&hitsPerPage=30`),
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

    // Helper for X (Twitter) via Apify - runs each query in PARALLEL to avoid sequential timeout
    const fetchXQuery = async (query: string) => {
      const docs: any[] = [];
      try {
        console.log(`X/Twitter: searching "${query}"`);
        const runRes = await fetchWithTimeout("https://api.apify.com/v2/acts/viralanalyzer~twitter-scraper/run-sync-get-dataset-items?token=" + APIFY_API_KEY, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            searchQuery: query,
            maxTweets: 20,
            tweetType: "top",
          }),
        });
        if (runRes.ok) {
          const items = await runRes.json();
          console.log(`X/Twitter results for "${query}": ${(items || []).length}`);
          for (const item of items || []) {
            const text = item.full_text || item.text || item.tweet_text || "";
            if (text.trim().length > 0) {
              docs.push({
                question_id: questionId, source: "x",
                url: item.tweet_url || item.url || null,
                author: item.username || item.screen_name || item.user?.screen_name || null,
                text: text.slice(0, 1500),
                date: item.created_at || item.date || null,
                engagement_metrics: {
                  likes: item.likes || item.favorite_count || 0,
                  retweets: item.retweets || item.retweet_count || 0,
                  replies: item.replies || item.reply_count || 0,
                  views: item.views || 0,
                },
              });
            }
          }
        } else {
          const errText = await runRes.text();
          console.error(`X/Twitter Apify failed for "${query}":`, runRes.status, errText);
        }
      } catch (e) { console.error(`X/Twitter error for "${query}":`, e); }
      return docs;
    };

    // Helper for Stack Overflow via Stack Exchange API (free, no key needed)
    const fetchStackOverflow = async (query: string) => {
      const docs: any[] = [];
      try {
        console.log(`StackOverflow API searching: ${query}`);
        const soRes = await fetch(
          `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=25&filter=withbody`
        );
        if (soRes.ok) {
          const data = await soRes.json();
          const items = data.items || [];
          console.log(`StackOverflow API results: ${items.length} (quota remaining: ${data.quota_remaining})`);
          for (const item of items) {
            const body = (item.body || "").replace(/<[^>]+>/g, "");
            const text = `${item.title}\n${body}`;
            if (text.trim().length > 0) {
              docs.push({
                question_id: questionId, source: "stackoverflow",
                url: item.link || null,
                author: item.owner?.display_name || null,
                text: text.slice(0, 2000),
                date: item.creation_date ? new Date(item.creation_date * 1000).toISOString() : null,
                engagement_metrics: { score: item.score, answers: item.answer_count, views: item.view_count },
              });
            }
          }
        } else {
          console.error("StackOverflow API failed:", soRes.status, await soRes.text());
        }
      } catch (e) { console.error("StackOverflow error:", e); }
      return docs;
    };

    // Helper for Substack (via Firecrawl search)
    // Run two searches: one scoped to substack.com, one broader with "substack" keyword
    const fetchSubstack = async (query: string) => {
      const docs: any[] = [];
      try {
        const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY");
        if (!FIRECRAWL_API_KEY) {
          console.error("FIRECRAWL_API_KEY not configured, skipping Substack");
          return docs;
        }

        const searches = [
          `site:substack.com ${query}`,
          `${query} substack`,
        ];

        const seenUrls = new Set<string>();

        for (const searchQuery of searches) {
          console.log(`Substack (Firecrawl) searching: ${searchQuery}`);
          const res = await fetch("https://api.firecrawl.dev/v1/search", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${FIRECRAWL_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              query: searchQuery,
              limit: 10,
              scrapeOptions: { formats: ["markdown"] },
            }),
          });
          if (res.ok) {
            const data = await res.json();
            const results = data?.data || [];
            console.log(`Substack (Firecrawl) results for "${searchQuery}": ${results.length}`);
            for (const item of results) {
              const url = item.url || "";
              if (!url.includes("substack.com") && !url.includes("substack")) continue;
              if (seenUrls.has(url)) continue;
              seenUrls.add(url);

              const text = item.markdown || item.description || "";
              if (text.trim().length > 0) {
                docs.push({
                  question_id: questionId, source: "substack",
                  url: url || null,
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
        }
      } catch (e) { console.error("Substack error:", e); }
      return docs;
    };

    // Run ALL queries across ALL platforms in parallel
    const tasks: Promise<any[]>[] = [];

    if (sources.includes("reddit")) {
      const queries = getQueries("reddit");
      console.log("Reddit queries:", queries);
      tasks.push(withSourceTimeout(fetchReddit(queries), "Reddit"));
    }
    if (sources.includes("hackernews")) {
      const queries = getQueries("hackernews");
      console.log("HN queries:", queries);
      for (const q of queries) tasks.push(withSourceTimeout(fetchHN(q), `HN:${q}`));
    }
    if (sources.includes("substack")) {
      const queries = getQueries("substack");
      console.log("Substack queries:", queries);
      for (const q of queries) tasks.push(withSourceTimeout(fetchSubstack(q), `Substack:${q}`));
    }
    if (sources.includes("x")) {
      const queries = getQueries("x");
      console.log("X/Twitter queries:", queries);
      for (const q of queries) tasks.push(withSourceTimeout(fetchXQuery(q), `X:${q}`));
    }
    if (sources.includes("stackoverflow")) {
      const queries = getQueries("stackoverflow");
      console.log("StackOverflow queries:", queries);
      for (const q of queries) tasks.push(withSourceTimeout(fetchStackOverflow(q), `SO:${q}`, 15000));
    }

    const settled = await Promise.allSettled(tasks);
    for (const result of settled) {
      if (result.status === "fulfilled") allDocuments.push(...result.value);
      else console.error("Source task rejected:", result.reason);
    }

    // Filter documents: must have text AND be within the requested time range
    if (allDocuments.length > 0) {
      const filtered = allDocuments.filter((d) => {
        if (!d.text || d.text.trim().length === 0) return false;
        // If document has a date, enforce the time range cutoff
        if (d.date) {
          const docDate = new Date(d.date);
          if (!isNaN(docDate.getTime()) && docDate < cutoffDate) return false;
        }
        return true;
      });
      console.log(`Documents after time filter: ${filtered.length} (from ${allDocuments.length} total, cutoff: ${cutoffDate.toISOString()})`);
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
