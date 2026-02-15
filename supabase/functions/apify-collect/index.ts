import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 45000): Promise<Response> {
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
        if (!d.date) return false; // No date = can't verify time range, reject
        const docDate = new Date(d.date);
        if (isNaN(docDate.getTime())) return false;
        if (docDate < cutoffDate) return false;
        return true;
      });
      if (filtered.length > 0) {
        const { error } = await supabase.from("documents").insert(filtered);
        if (error) console.error("Insert error:", error);
        else totalInserted += filtered.length;
      }
      return filtered.length;
    };

    // ── Reddit via Apify (parseforge/reddit-posts-scraper — 1000+ posts/min, pay-per-event) ──
    const fetchReddit = async (queries: string[]) => {
      try {
        const allDocs: any[] = [];
        const sortParam = timeRangeDays <= 7 ? "new" : "top";
        const timeParam = timeRangeDays <= 7 ? "week" : timeRangeDays <= 30 ? "month" : "year";
        const results = await Promise.allSettled(
          queries.map(async (query) => {
            console.log(`Reddit (parseforge): searching "${query}" sort=${sortParam} time=${timeParam}`);
            const res = await fetchWithTimeout(
              "https://api.apify.com/v2/acts/parseforge~reddit-posts-scraper/run-sync-get-dataset-items?token=" + APIFY_API_KEY,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  searchQueries: [query],
                  sort: sortParam,
                  time: timeParam,
                  maxItems: 100,
                  proxyConfiguration: {
                    useApifyProxy: true,
                    apifyProxyGroups: ["RESIDENTIAL"],
                  },
                }),
              },
              50000
            );
            if (!res.ok) {
              console.error(`Reddit parseforge failed for "${query}":`, res.status, await res.text());
              return [];
            }
            const items = await res.json();
            console.log(`Reddit results for "${query}": ${(items || []).length}`);
            const docs: any[] = [];
            for (const item of items || []) {
              const text = (item.title || "") + (item.selfText ? "\n" + item.selfText : "");
              if (text.trim().length > 0) {
                docs.push({
                  question_id: questionId, source: "reddit",
                  url: item.url || (item.permalink ? `https://reddit.com${item.permalink}` : null),
                  author: item.author || null,
                  text: text.slice(0, 2000),
                  date: item.createdAt || null,
                  engagement_metrics: { score: item.score || 0, comments: item.numComments || 0 },
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

    // ── Stack Overflow via Apify (muscular_quadruplet/stackoverflow-scraper) ──
    const fetchStackOverflow = async (query: string) => {
      try {
        console.log(`StackOverflow (Apify): searching "${query}"`);
        const res = await fetchWithTimeout(
          "https://api.apify.com/v2/acts/muscular_quadruplet~stackoverflow-scraper/run-sync-get-dataset-items?token=" + APIFY_API_KEY,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mode: "search",
              searchQuery: query,
              sortBy: "relevance",
              maxResults: 100,
            }),
          },
          35000
        );
        if (!res.ok) {
          console.error(`StackOverflow Apify failed for "${query}":`, res.status, await res.text());
          return;
        }
        const items = await res.json();
        console.log(`StackOverflow Apify results for "${query}": ${(items || []).length}`);
        if ((items || []).length > 0) {
          console.log(`StackOverflow sample item keys:`, JSON.stringify(Object.keys(items[0])));
          console.log(`StackOverflow sample date fields:`, JSON.stringify({
            creation_date: items[0].creation_date, createdAt: items[0].createdAt,
            date: items[0].date, last_activity_date: items[0].last_activity_date,
            created: items[0].created, timestamp: items[0].timestamp,
          }));
        }
        const docs: any[] = [];
        for (const item of items || []) {
          const body = (item.body || item.content || "").replace(/<[^>]+>/g, "");
          const title = item.title || "";
          const text = title + (body ? "\n" + body : "");
          if (text.trim().length > 0) {
            // Try multiple date formats: unix seconds, unix ms, ISO string
            let dateStr: string | null = null;
            const rawDate = item.creation_date || item.createdAt || item.date || item.last_activity_date || item.created || item.timestamp;
            if (rawDate) {
              if (typeof rawDate === "number") {
                // If < 1e12 it's seconds, otherwise ms
                dateStr = new Date(rawDate < 1e12 ? rawDate * 1000 : rawDate).toISOString();
              } else if (typeof rawDate === "string") {
                const parsed = new Date(rawDate);
                if (!isNaN(parsed.getTime())) dateStr = parsed.toISOString();
              }
            }
            docs.push({
              question_id: questionId, source: "stackoverflow",
              url: item.link || item.url || null,
              author: item.owner?.display_name || item.author || null,
              text: text.slice(0, 2000),
              date: dateStr,
              engagement_metrics: { score: item.score || 0, answers: item.answer_count || 0, views: item.view_count || 0 },
            });
          }
        }
        if (docs.length > 0) {
          const count = await insertDocs(docs);
          console.log(`StackOverflow: inserted ${count} docs`);
        }
      } catch (e) { console.error("StackOverflow error:", e); }
    };

    // ── Substack via Apify (google-search to find substack content) ──
    const fetchSubstack = async (query: string) => {
      try {
        // Use Apify's Google Search Results scraper to find Substack posts
        const searches = [`site:substack.com ${query}`, `"${query}" substack newsletter`];
        const seenUrls = new Set<string>();
        const docs: any[] = [];

        const results = await Promise.allSettled(
          searches.map(async (searchQuery) => {
            console.log(`Substack (Apify Google Search): searching "${searchQuery}"`);
            const res = await fetchWithTimeout(
              "https://api.apify.com/v2/acts/apify~google-search-scraper/run-sync-get-dataset-items?token=" + APIFY_API_KEY,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  queries: searchQuery,
                  maxPagesPerQuery: 3,
                  resultsPerPage: 25,
                  languageCode: "en",
                }),
              },
              35000
            );
            if (!res.ok) {
              console.error(`Substack Apify Google Search failed:`, res.status, await res.text());
              return [];
            }
            const data = await res.json();
            // Google search scraper returns organic results nested
            const allResults: any[] = [];
            for (const page of data || []) {
              if (page.organicResults) allResults.push(...page.organicResults);
            }
            return allResults;
          })
        );

        for (const r of results) {
          if (r.status !== "fulfilled") continue;
          for (const item of r.value) {
            const url = item.url || item.link || "";
            if (seenUrls.has(url)) continue;
            seenUrls.add(url);
            const text = (item.title || "") + (item.description || item.snippet ? "\n" + (item.description || item.snippet) : "");
            if (text.trim().length > 0) {
              // Google Search results rarely have dates; use today as proxy since search results are recent
              const docDate = item.date || new Date().toISOString();
              docs.push({
                question_id: questionId, source: "substack",
                url: url || null,
                author: item.displayedUrl || null,
                text: text.slice(0, 2000),
                date: docDate,
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
