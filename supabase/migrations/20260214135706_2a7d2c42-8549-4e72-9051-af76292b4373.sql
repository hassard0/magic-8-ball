
-- Fix the overly permissive org insert policy
-- Users should only create orgs during signup flow, so we keep it but it's necessary
DROP POLICY "org_insert" ON public.organizations;

-- Only allow insert if the user doesn't already belong to an org
CREATE POLICY "org_insert" ON public.organizations FOR INSERT TO authenticated
  WITH CHECK (
    NOT EXISTS (
      SELECT 1 FROM public.user_roles WHERE user_id = auth.uid()
    )
  );
