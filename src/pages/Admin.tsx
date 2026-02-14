import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import AppLayout from "@/components/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { UserPlus, Mail, Loader2 } from "lucide-react";
import type { Tables, Json } from "@/integrations/supabase/types";

type Profile = Tables<"profiles">;
type UserRole = Tables<"user_roles">;
type Invite = Tables<"invites">;

interface Member {
  profile: Profile;
  role: UserRole;
}

interface OrgSettings {
  enabled_sources: string[];
}

export default function Admin() {
  const { orgId, user, isAdmin } = useAuth();
  const { toast } = useToast();
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [settings, setSettings] = useState<OrgSettings>({ enabled_sources: ["reddit", "hackernews", "substack"] });

  useEffect(() => {
    if (!orgId) return;
    loadData();
  }, [orgId]);

  const loadData = async () => {
    if (!orgId) return;

    const [rolesRes, invitesRes, orgRes] = await Promise.all([
      supabase.from("user_roles").select("*").eq("org_id", orgId),
      supabase.from("invites").select("*").eq("org_id", orgId).order("created_at", { ascending: false }),
      supabase.from("organizations").select("settings").eq("id", orgId).single(),
    ]);

    // Fetch profiles for members
    if (rolesRes.data) {
      const userIds = rolesRes.data.map((r) => r.user_id);
      const { data: profiles } = await supabase
        .from("profiles")
        .select("*")
        .in("user_id", userIds);

      const memberList = rolesRes.data.map((role) => ({
        role,
        profile: profiles?.find((p) => p.user_id === role.user_id) || ({} as Profile),
      }));
      setMembers(memberList);
    }

    setInvites(invitesRes.data || []);
    if (orgRes.data?.settings) {
      setSettings(orgRes.data.settings as unknown as OrgSettings);
    }
  };

  const handleInvite = async () => {
    if (!inviteEmail.trim() || !orgId || !user) return;
    setInviting(true);
    try {
      const { error } = await supabase.functions.invoke("invite-user", {
        body: { email: inviteEmail.trim(), orgId, role: "member" },
      });
      if (error) throw error;
      toast({ title: "Invite sent", description: `Invitation sent to ${inviteEmail}` });
      setInviteEmail("");
      loadData();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setInviting(false);
    }
  };

  const toggleSource = async (source: string) => {
    if (!orgId) return;
    const newSources = settings.enabled_sources.includes(source)
      ? settings.enabled_sources.filter((s) => s !== source)
      : [...settings.enabled_sources, source];

    const newSettings = { ...settings, enabled_sources: newSources };
    setSettings(newSettings);

    await supabase
      .from("organizations")
      .update({ settings: newSettings as unknown as Json })
      .eq("id", orgId);
  };

  if (!isAdmin) {
    return (
      <AppLayout>
        <p className="text-sm text-muted-foreground">Admin access required.</p>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Admin Panel</h1>
          <p className="text-sm text-muted-foreground mt-1">Manage your organization</p>
        </div>

        <Tabs defaultValue="members" className="space-y-4">
          <TabsList className="bg-secondary/50">
            <TabsTrigger value="members">Members</TabsTrigger>
            <TabsTrigger value="sources">Sources</TabsTrigger>
          </TabsList>

          <TabsContent value="members" className="space-y-4">
            {/* Invite */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Invite Member</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex gap-3">
                  <Input
                    placeholder="colleague@company.com"
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    className="flex-1 bg-secondary/30"
                  />
                  <Button onClick={handleInvite} disabled={inviting || !inviteEmail.trim()}>
                    {inviting ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4 mr-2" />}
                    Invite
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Members list */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Members ({members.length})</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-border">
                  {members.map((m) => (
                    <div key={m.role.id} className="flex items-center justify-between px-4 py-3">
                      <div>
                        <p className="text-sm font-medium">{m.profile.display_name || "Unknown"}</p>
                      </div>
                      <Badge variant="outline" className="text-xs capitalize">{m.role.role}</Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Pending invites */}
            {invites.filter((i) => i.status === "pending").length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">Pending Invites</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="divide-y divide-border">
                    {invites
                      .filter((i) => i.status === "pending")
                      .map((i) => (
                        <div key={i.id} className="flex items-center justify-between px-4 py-3">
                          <div className="flex items-center gap-2">
                            <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className="text-sm">{i.email}</span>
                          </div>
                          <span className="text-xs text-muted-foreground font-mono">
                            Expires {new Date(i.expires_at).toLocaleDateString()}
                          </span>
                        </div>
                      ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="sources" className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Enabled Sources</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {[
                  { key: "reddit", label: "Reddit", icon: "🔴" },
                  { key: "hackernews", label: "Hacker News", icon: "🟠" },
                  { key: "substack", label: "Substack", icon: "🟣" },
                ].map((s) => (
                  <div key={s.key} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span>{s.icon}</span>
                      <span className="text-sm">{s.label}</span>
                    </div>
                    <Switch
                      checked={settings.enabled_sources.includes(s.key)}
                      onCheckedChange={() => toggleSource(s.key)}
                    />
                  </div>
                ))}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
