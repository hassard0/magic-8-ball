-- Allow users to delete documents for questions in their org
CREATE POLICY "documents_delete"
ON public.documents
FOR DELETE
USING (is_org_member(auth.uid(), get_org_id_for_question(question_id)));

-- Allow users to delete analysis results for questions in their org
CREATE POLICY "analysis_delete"
ON public.analysis_results
FOR DELETE
USING (is_org_member(auth.uid(), get_org_id_for_question(question_id)));

-- Allow question owners or org admins to delete questions
CREATE POLICY "questions_delete"
ON public.questions
FOR DELETE
USING ((asked_by = auth.uid()) OR is_org_admin(auth.uid(), org_id));