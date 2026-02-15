import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 30000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { questionId, questionText, sources, timeRange, optimizedQueries, entityTag } = await req.json();
    const getQueries = (platform: string): string[] => {
      if (optimizedQueries?.[platform]?.length > 0) return optimizedQueries[platform];
      return [questionText];
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

    let totalInserted = 0;

    /** Insert docs immediately for a source — don't wait for other sources */
    const insertDocs = async (docs: any[]) => {
      const filtered = docs.filter((d) => {
        if (!d.text || d.text.trim().length === 0) return false;
        if (d.date) {
          const docDate = new Date(d.date);
          if (!isNaN(docDate.getTime()) && docDate < cutoffDate) return false;
        } else {
          if (d.source !== "substack") return false;
        }
        return true;
      });
      if (filtered.length > 0) {
        const { error } = await supabase.from("documents").insert(filtered);
        if (error) console.error("Insert error:", error);
        else totalInserted += filtered.length;
      }
      return filtered.length;
    };

    // ── Reddit via Apify (vulnv/reddit-posts-search-scraper — pay-per-result, no subscription) ──
    const fetchReddit = async (queries: string[]) => {
      try {
        const allDocs: any[] = [];
        const sortParam = timeRangeDays <= 7 ? "new" : "relevance";
        const results = await Promise.allSettled(
          queries.map(async (query) => {
            console.log(`Reddit (Apify vulnv): searching "${query}" sort=${sortParam} limit=100`);
            const res = await fetchWithTimeout(
              "https://api.apify.com/v2/acts/vulnv~reddit-posts-search-scraper/run-sync-get-dataset-items?token=" + APIFY_API_KEY,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  keyword: query,
                  limit: 100,
                  sort: sortParam,
                }),
              },
              35000
            );
            if (!res.ok) {
              console.error(`Reddit Apify failed for "${query}":`, res.status, await res.text());
              return [];
            }
            const items = await res.json();
            console.log(`Reddit results for "${query}": ${(items || []).length}`);
            const docs: any[] = [];
            for (const item of items || []) {
              const text = (item.title || "") + (item.selftext || item.body || item.text ? "\n" + (item.selftext || item.body || item.text) : "");
              if (text.trim().length > 0) {
                docs.push({
                  question_id: questionId, source: "reddit",
                  url: item.url || (item.permalink ? `https://reddit.com${item.permalink}` : null),
                  author: item.author || item.username || null,
                  text: text.slice(0, 2000),
                  date: item.created_utc ? new Date(item.created_utc * 1000).toISOString() : item.createdAt || item.created || null,
                  engagement_metrics: { score: item.score || item.ups || 0, comments: item.num_comments || item.numberOfComments || 0 },
                });
              }
            }
            return docs;
          })
        );
        for (const r of results) {
          if (r.status === "fulfilled") allDocs.push(...r.value);
        }
        if (allDocs.length > 0) {
          const count = await insertDocs(allDocs);
          console.log(`Reddit: inserted ${count} docs`);
        }
      } catch (e) { console.error("Reddit error:", e); }
    };

    // ── HN via Algolia API ──
    const fetchHN = async (query: string) => {
      try {
        const dateFilter = `created_at_i>${cutoffTimestamp}`;
        const [storiesRes, commentsRes] = await Promise.all([
          fetch(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&numericFilters=${dateFilter}&hitsPerPage=100`),
          fetch(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=comment&numericFilters=${dateFilter}&hitsPerPage=150`),
        ]);
        const docs: any[] = [];
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
          console.log(`HN comments for "${query}": ${(data.hits || []).length}`);
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
        if (docs.length > 0) {
          const count = await insertDocs(docs);
          console.log(`HN: inserted ${count} docs`);
        }
      } catch (e) { console.error("HN error:", e); }
    };

    // ── X (Twitter) via Apify ──
    const fetchXQuery = async (query: string) => {
      try {
        console.log(`X/Twitter: searching "${query}"`);
        const runRes = await fetchWithTimeout(
          "https://api.apify.com/v2/acts/xtdata~twitter-x-scraper/run-sync-get-dataset-items?token=" + APIFY_API_KEY,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ searchTerms: [query], maxItems: 100, sort: "Top" }),
          },
          35000
        );
        if (!runRes.ok) {
          console.error(`X/Twitter failed for "${query}":`, runRes.status, await runRes.text());
          return;
        }
        const items = await runRes.json();
        console.log(`X/Twitter results for "${query}": ${(items || []).length}`);
        const docs: any[] = [];
        for (const item of items || []) {
          const text = item.full_text || item.text || item.tweet_text || item.content || "";
          if (text.trim().length > 0) {
            docs.push({
              question_id: questionId, source: "x",
              url: item.url || item.tweet_url || item.tweetUrl || null,
              author: item.user_name || item.username || item.screen_name || item.author || null,
              text: text.slice(0, 1500),
              date: item.created_at || item.date || item.timestamp || null,
              engagement_metrics: {
                likes: item.likes || item.favorite_count || item.likeCount || 0,
                retweets: item.retweets || item.retweet_count || item.retweetCount || 0,
                replies: item.replies || item.reply_count || item.replyCount || 0,
                views: item.views || item.viewCount || 0,
              },
            });
          }
        }
        if (docs.length > 0) {
          const count = await insertDocs(docs);
          console.log(`X/Twitter: inserted ${count} docs`);
        }
      } catch (e) { console.error(`X/Twitter error for "${query}":`, e); }
    };

    // ── Stack Overflow via Stack Exchange API ──
    const fetchStackOverflow = async (query: string) => {
      try {
        console.log(`StackOverflow API searching: ${query}`);
        const soRes = await fetch(
          `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=100&filter=withbody&fromdate=${cutoffTimestamp}`
        );
        if (!soRes.ok) {
          console.error("StackOverflow API failed:", soRes.status);
          return;
        }
        const data = await soRes.json();
        const items = data.items || [];
        console.log(`StackOverflow results: ${items.length}`);
        const docs: any[] = [];
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
        if (docs.length > 0) {
          const count = await insertDocs(docs);
          console.log(`StackOverflow: inserted ${count} docs`);
        }
      } catch (e) { console.error("StackOverflow error:", e); }
    };

    // ── Substack via Firecrawl — run both searches in PARALLEL ──
    const fetchSubstack = async (query: string) => {
      try {
        const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY");
        if (!FIRECRAWL_API_KEY) { console.error("FIRECRAWL_API_KEY not configured"); return; }

        const tbs = timeRangeDays <= 7 ? "qdr:w" : timeRangeDays <= 30 ? "qdr:m" : "qdr:y";
        const searches = [`site:substack.com ${query}`, `${query} substack`];
        const seenUrls = new Set<string>();
        const docs: any[] = [];

        // Run both searches in parallel instead of sequentially
        const results = await Promise.allSettled(
          searches.map(async (searchQuery) => {
            console.log(`Substack (Firecrawl) searching: ${searchQuery}`);
            const res = await fetchWithTimeout("https://api.firecrawl.dev/v1/search", {
              method: "POST",
              headers: { "Authorization": `Bearer ${FIRECRAWL_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({ query: searchQuery, limit: 25, tbs, scrapeOptions: { formats: ["markdown"] } }),
            }, 20000);
            if (!res.ok) { console.error(`Substack Firecrawl failed:`, res.status); return []; }
            const data = await res.json();
            return data?.data || [];
          })
        );

        for (const r of results) {
          if (r.status !== "fulfilled") continue;
          for (const item of r.value) {
            const url = item.url || "";
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
        }
        if (docs.length > 0) {
          const count = await insertDocs(docs);
          console.log(`Substack: inserted ${count} docs`);
        }
      } catch (e) { console.error("Substack error:", e); }
    };

    // ── Run all sources in parallel — each inserts its own docs immediately ──
    const tasks: Promise<void>[] = [];

    if (sources.includes("reddit")) {
      tasks.push(fetchReddit(getQueries("reddit")));
    }
    if (sources.includes("hackernews")) {
      for (const q of getQueries("hackernews")) tasks.push(fetchHN(q));
    }
    if (sources.includes("substack")) {
      for (const q of getQueries("substack")) tasks.push(fetchSubstack(q));
    }
    if (sources.includes("x")) {
      for (const q of getQueries("x")) tasks.push(fetchXQuery(q));
    }
    if (sources.includes("stackoverflow")) {
      for (const q of getQueries("stackoverflow")) tasks.push(fetchStackOverflow(q));
    }

    await Promise.allSettled(tasks);

    console.log(`Collection complete: ${totalInserted} documents inserted total`);
    return new Response(JSON.stringify({ success: true, count: totalInserted }), {
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
