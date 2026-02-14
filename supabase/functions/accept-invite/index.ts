import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Unauthorized");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) throw new Error("Unauthorized");

    const { token } = await req.json();
    if (!token) throw new Error("token required");

    // Find invite
    const { data: invite, error: inviteErr } = await supabase
      .from("invites")
      .select("*")
      .eq("token", token)
      .eq("status", "pending")
      .single();

    if (inviteErr || !invite) throw new Error("Invalid or expired invite");

    // Check expiry
    if (new Date(invite.expires_at) < new Date()) {
      await supabase.from("invites").update({ status: "expired" }).eq("id", invite.id);
      throw new Error("Invite has expired");
    }

    // Add user to org
    await supabase
      .from("profiles")
      .update({ org_id: invite.org_id })
      .eq("user_id", user.id);

    await supabase.from("user_roles").insert({
      user_id: user.id,
      org_id: invite.org_id,
      role: invite.role,
    });

    // Mark invite as accepted
    await supabase
      .from("invites")
      .update({ status: "accepted" })
      .eq("id", invite.id);

    return new Response(JSON.stringify({ success: true, orgId: invite.org_id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("accept-invite error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
