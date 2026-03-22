# 🎱 Magic 8-Ball — Community Sentiment Analysis

Magic 8-Ball answers your questions about community sentiment by scraping Reddit, Hacker News, and Substack, then analyzing the results with AI. Ask anything — from "How do people feel about Cursor IDE?" to "Should I buy more pokemon cards?" — and get a data-driven verdict.

## How It Works

1. **Ask a question** — type a natural language question and pick your sources (Reddit, Hacker News, Substack) and time range (7d / 30d / 90d).
2. **AI classifies & optimizes** — Gemini classifies the question (standard, comparative, or abstract) and generates targeted search keywords.
3. **Data collection** — Apify actors scrape community discussions from the selected platforms. Firecrawl handles Substack searches.
4. **Relevance filtering** — An AI pass removes off-topic results to keep analysis focused.
5. **Sentiment analysis** — Gemini analyzes the collected posts and produces:
   - Overall sentiment score (−100 to +100)
   - Sentiment distribution (positive / neutral / negative %)
   - Key themes with explanations
   - Representative quotes with source links
   - Per-source breakdown
   - A Magic 8-Ball–style verdict
6. **Comparative mode** — Ask "X vs Y" questions and get side-by-side analysis of both entities.

## Tech Stack

- **Frontend** — React, TypeScript, Vite, Tailwind CSS, shadcn/ui, Recharts, Framer Motion
- **Backend** — Supabase (Postgres, Edge Functions, Auth, RLS)
- **AI** — Google Gemini
- **Scraping** — Apify (Reddit & Hacker News actors), Firecrawl (Substack)

## Integration Requirements

| Service | Purpose | Setup |
|---------|---------|-------|
| **Apify** | Scrapes Reddit and Hacker News | Add `APIFY_API_KEY` as a backend secret |
| **Firecrawl** | Searches Substack articles | Add `FIRECRAWL_API_KEY` as a backend secret |
| **Resend** | Sends team invite emails | Add `RESEND_API_KEY` as a backend secret |
| **Lovable AI** | Question classification & sentiment analysis | Pre-configured — no setup needed |

## Features

- 🔍 Multi-source scraping (Reddit, HN, Substack)
- 🆚 Comparative analysis (X vs Y)
- 📊 Rich results with charts, themes, and quotes
- 👥 Multi-user orgs with role-based access (admin / member)
- 📧 Email invites for team members
- 📜 Question history with cached results
- 🎨 Dark, data-dense dashboard UI

## Development

```sh
npm i
npm run dev
```

## Deployment

Open [Lovable](https://lovable.dev) and click **Share → Publish**.
