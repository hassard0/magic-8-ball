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
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    // Verify user
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) throw new Error("Unauthorized");

    const { email, orgId, role } = await req.json();
    if (!email || !orgId) throw new Error("email and orgId required");

    // Verify caller is admin
    const { data: callerRole } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("org_id", orgId)
      .single();

    if (!callerRole || callerRole.role !== "admin") {
      throw new Error("Admin access required");
    }

    // Create invite
    const { data: invite, error: inviteErr } = await supabase
      .from("invites")
      .insert({
        email,
        org_id: orgId,
        role: role || "member",
        invited_by: user.id,
      })
      .select()
      .single();

    if (inviteErr) throw inviteErr;

    // Send email via Resend
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (RESEND_API_KEY) {
      const { data: org } = await supabase
        .from("organizations")
        .select("name")
        .eq("id", orgId)
        .single();

      const acceptUrl = `${req.headers.get("origin") || supabaseUrl}/auth?invite=${invite.token}`;

      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Magic 8-Ball <onboarding@resend.dev>",
          to: [email],
          subject: `You've been invited to ${org?.name || "an organization"} on Magic 8-Ball`,
          html: `
            <h2>🎱 You've been invited!</h2>
            <p>You've been invited to join <strong>${org?.name || "an organization"}</strong> on Magic 8-Ball.</p>
            <p><a href="${acceptUrl}" style="display:inline-block;padding:12px 24px;background:#7c3aed;color:white;border-radius:8px;text-decoration:none;font-weight:600;">Accept Invitation</a></p>
            <p style="color:#666;font-size:12px;">This invite expires in 7 days.</p>
          `,
        }),
      });
      const emailBody = await emailRes.text();
      console.log("Resend response:", emailRes.status, emailBody);
      if (!emailRes.ok) {
        console.error("Resend email failed:", emailRes.status, emailBody);
      }
    } else {
      console.warn("RESEND_API_KEY not set, skipping email");
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("invite-user error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
