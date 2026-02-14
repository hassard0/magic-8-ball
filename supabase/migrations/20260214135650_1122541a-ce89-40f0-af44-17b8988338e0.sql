
-- Create role enum
CREATE TYPE public.app_role AS ENUM ('admin', 'member');

-- Create question status enum
CREATE TYPE public.question_status AS ENUM ('queued', 'running', 'complete', 'failed');

-- Create invite status enum
CREATE TYPE public.invite_status AS ENUM ('pending', 'accepted', 'expired');

-- Organizations table
CREATE TABLE public.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  settings JSONB NOT NULL DEFAULT '{"enabled_sources": ["reddit", "hackernews", "substack"]}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Profiles table
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  display_name TEXT,
  avatar_url TEXT,
  org_id UUID REFERENCES public.organizations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- User roles table (separate from profiles for security)
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role public.app_role NOT NULL DEFAULT 'member',
  org_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE NOT NULL,
  UNIQUE(user_id, org_id)
);

-- Invites table
CREATE TABLE public.invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  org_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE NOT NULL,
  role public.app_role NOT NULL DEFAULT 'member',
  status public.invite_status NOT NULL DEFAULT 'pending',
  invited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  token TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Questions table
CREATE TABLE public.questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE NOT NULL,
  asked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  question_text TEXT NOT NULL,
  time_range TEXT NOT NULL DEFAULT '30d',
  sources TEXT[] NOT NULL DEFAULT ARRAY['reddit', 'hackernews', 'substack'],
  status public.question_status NOT NULL DEFAULT 'queued',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Documents table (raw scraped posts)
CREATE TABLE public.documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id UUID REFERENCES public.questions(id) ON DELETE CASCADE NOT NULL,
  source TEXT NOT NULL,
  url TEXT,
  author TEXT,
  text TEXT NOT NULL,
  date TIMESTAMPTZ,
  engagement_metrics JSONB DEFAULT '{}'::jsonb,
  sentiment_label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Analysis results table
CREATE TABLE public.analysis_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id UUID REFERENCES public.questions(id) ON DELETE CASCADE NOT NULL UNIQUE,
  overall_score INTEGER,
  distribution JSONB DEFAULT '{"positive": 0, "neutral": 0, "negative": 0}'::jsonb,
  confidence NUMERIC(3,2),
  themes JSONB DEFAULT '[]'::jsonb,
  verdict TEXT,
  quotes JSONB DEFAULT '[]'::jsonb,
  source_breakdown JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS on all tables
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_results ENABLE ROW LEVEL SECURITY;

-- Helper function: check if user is member of org (SECURITY DEFINER to avoid recursion)
CREATE OR REPLACE FUNCTION public.is_org_member(_user_id UUID, _org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND org_id = _org_id
  )
$$;

-- Helper function: check if user has admin role
CREATE OR REPLACE FUNCTION public.is_org_admin(_user_id UUID, _org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND org_id = _org_id AND role = 'admin'
  )
$$;

-- Helper: get org_id from question
CREATE OR REPLACE FUNCTION public.get_org_id_for_question(_question_id UUID)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT org_id FROM public.questions WHERE id = _question_id
$$;

-- ========== RLS POLICIES ==========

-- Organizations: members can read, admins can update
CREATE POLICY "org_select" ON public.organizations FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), id));
CREATE POLICY "org_insert" ON public.organizations FOR INSERT TO authenticated
  WITH CHECK (true);
CREATE POLICY "org_update" ON public.organizations FOR UPDATE TO authenticated
  USING (public.is_org_admin(auth.uid(), id));

-- Profiles: org members can read, own profile can be updated, auto-created on signup
CREATE POLICY "profiles_select" ON public.profiles FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), org_id) OR user_id = auth.uid());
CREATE POLICY "profiles_insert" ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
CREATE POLICY "profiles_update" ON public.profiles FOR UPDATE TO authenticated
  USING (user_id = auth.uid());

-- User roles: org members can read, admins can manage
CREATE POLICY "roles_select" ON public.user_roles FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), org_id));
CREATE POLICY "roles_insert" ON public.user_roles FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() OR public.is_org_admin(auth.uid(), org_id));
CREATE POLICY "roles_update" ON public.user_roles FOR UPDATE TO authenticated
  USING (public.is_org_admin(auth.uid(), org_id));
CREATE POLICY "roles_delete" ON public.user_roles FOR DELETE TO authenticated
  USING (public.is_org_admin(auth.uid(), org_id));

-- Invites: admins can manage
CREATE POLICY "invites_select" ON public.invites FOR SELECT TO authenticated
  USING (public.is_org_admin(auth.uid(), org_id));
CREATE POLICY "invites_insert" ON public.invites FOR INSERT TO authenticated
  WITH CHECK (public.is_org_admin(auth.uid(), org_id));
CREATE POLICY "invites_update" ON public.invites FOR UPDATE TO authenticated
  USING (public.is_org_admin(auth.uid(), org_id));
CREATE POLICY "invites_delete" ON public.invites FOR DELETE TO authenticated
  USING (public.is_org_admin(auth.uid(), org_id));

-- Questions: org members can read/create, owners & admins can modify
CREATE POLICY "questions_select" ON public.questions FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), org_id));
CREATE POLICY "questions_insert" ON public.questions FOR INSERT TO authenticated
  WITH CHECK (public.is_org_member(auth.uid(), org_id) AND asked_by = auth.uid());
CREATE POLICY "questions_update" ON public.questions FOR UPDATE TO authenticated
  USING (asked_by = auth.uid() OR public.is_org_admin(auth.uid(), org_id));

-- Documents: org members can read, service role inserts
CREATE POLICY "documents_select" ON public.documents FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), public.get_org_id_for_question(question_id)));
CREATE POLICY "documents_insert" ON public.documents FOR INSERT TO authenticated
  WITH CHECK (public.is_org_member(auth.uid(), public.get_org_id_for_question(question_id)));

-- Analysis results: org members can read, service role inserts
CREATE POLICY "analysis_select" ON public.analysis_results FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), public.get_org_id_for_question(question_id)));
CREATE POLICY "analysis_insert" ON public.analysis_results FOR INSERT TO authenticated
  WITH CHECK (public.is_org_member(auth.uid(), public.get_org_id_for_question(question_id)));

-- Trigger: auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.email));
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Trigger: update updated_at on questions
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER update_questions_updated_at
  BEFORE UPDATE ON public.questions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Enable realtime for questions (status polling)
ALTER PUBLICATION supabase_realtime ADD TABLE public.questions;
