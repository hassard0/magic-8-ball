

# Magic 8-Ball — Full Implementation Plan

## Overview
A multi-user sentiment analysis platform that answers questions about community sentiment toward companies/topics by scraping Reddit, Hacker News, and Substack via Apify, then analyzing results with AI. Dashboard-forward, data-dense UI.

---

## Phase 1: Backend Foundation (Lovable Cloud)

### Database Schema
- **organizations** — id, name, created_at, settings (enabled sources JSON)
- **user_roles** — user_id, role (admin/member), org_id — using secure role enum pattern
- **profiles** — user_id, display_name, avatar_url, org_id
- **invites** — id, email, org_id, role, status (pending/accepted), invited_by, token, expires_at
- **questions** — id, org_id, asked_by, question_text, time_range, sources, status (queued/running/complete/failed), created_at
- **documents** — id, question_id, source, url, author, text, date, engagement_metrics, sentiment_label
- **analysis_results** — id, question_id, overall_score, distribution, confidence, themes, verdict, quotes, source_breakdown, created_at

### Authentication
- Email/password signup and login
- On signup, user creates or joins an organization
- RLS policies: users only see data within their org

### Edge Functions
1. **invite-user** — Admin sends invite email via Resend with a magic link/token
2. **accept-invite** — Processes invite token, adds user to org
3. **run-question** — Orchestrates the full pipeline:
   - Updates question status to "running"
   - Calls Apify actors for each selected source
   - Stores normalized documents
   - Calls AI analysis
   - Stores results, marks "complete"
4. **apify-collect** — Runs Apify actors (Reddit, HN, Substack) and normalizes results
5. **analyze-sentiment** — Calls Lovable AI (Gemini) with collected documents to produce quantitative + qualitative output using structured tool calling

---

## Phase 2: Pages & UI

### Login / Signup Page
- Clean auth form with email/password
- Option to create a new organization or accept an invite

### Dashboard (Home)
- Recent questions with status indicators (queued → running → complete)
- Quick-ask input at the top
- Org usage stats sidebar (questions this month, active members)
- Data-dense layout with tables and compact cards

### Ask Question Page
- Natural language input field
- Time range selector (7d / 30d / 90d)
- Source checkboxes (Reddit, HN, Substack) — respects org-level enabled sources
- Submit button → creates question, triggers pipeline
- Live status polling until complete

### Results Page
- **🎱 Verdict banner** — headline like "Mostly Negative" with overall score (-100 to +100)
- **Metrics row** — sentiment score, confidence, total mentions, source counts
- **Sentiment distribution chart** — bar/donut chart (positive/neutral/negative %)
- **Source breakdown chart** — by platform
- **Top themes** — expandable cards with explanations
- **Key arguments** — for vs. against in two columns
- **Representative quotes** — 5–10 quotes with source links and sentiment badges
- **Raw sources list** — collapsible table of all collected documents

### History Page
- Searchable/filterable table of all past questions in the org
- Status badges, timestamps, click to view results
- Cached results load instantly

### Admin Panel
- **Members tab** — list of org users with roles, invite button
- **Invite modal** — email input, role selector, sends via Resend
- **Sources tab** — toggle Reddit, HN, Substack on/off for the org
- **Usage tab** — questions asked over time, per-user breakdown

---

## Phase 3: Integration Wiring

### Apify Integration
- Store API key as a Supabase secret
- Edge function calls Apify API to run actors for Reddit search, HN search, and Substack search
- Polls for actor completion, downloads results, normalizes into documents table

### Resend Integration
- Store API key as a Supabase secret
- Edge function sends branded invite emails with accept link

### Lovable AI Integration
- Edge function sends collected document texts to Gemini with a structured prompt
- Uses tool calling to extract: sentiment scores, themes, quotes, verdict
- Stores structured results in analysis_results table

---

## Phase 4: Polish & UX

### Design System
- Dark, data-dense dashboard aesthetic (Datadog/Mixpanel inspired)
- Accent color for the Magic 8-Ball branding
- Compact typography, dense tables, muted backgrounds
- Subtle animations for status transitions

### Navigation
- Sidebar with: Dashboard, Ask, History, Admin (admin-only)
- Org switcher in header (future-proofing)
- Responsive but desktop-first

### Status & Feedback
- Toast notifications for actions (invite sent, question submitted)
- Skeleton loaders for results
- Error states with retry options
- Real-time status polling for running questions

