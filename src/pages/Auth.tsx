import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";

export default function Auth() {
  const [searchParams] = useSearchParams();
  const inviteToken = searchParams.get("invite");

  const [isLogin, setIsLogin] = useState(!inviteToken);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(false);
  const [acceptingInvite, setAcceptingInvite] = useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();

  // If user is already logged in and has an invite token, accept it immediately
  useEffect(() => {
    if (!inviteToken) return;

    const checkExistingSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        await acceptInvite(inviteToken);
      }
    };
    checkExistingSession();
  }, [inviteToken]);

  const acceptInvite = async (token: string) => {
    setAcceptingInvite(true);
    try {
      const { data, error } = await supabase.functions.invoke("accept-invite", {
        body: { token },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      toast({
        title: "Invite accepted!",
        description: "You've been added to the organization.",
      });
      // Small delay to let AuthContext refresh
      setTimeout(() => {
        window.location.href = "/";
      }, 500);
    } catch (error: any) {
      toast({
        title: "Invite error",
        description: error.message,
        variant: "destructive",
      });
      setAcceptingInvite(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      if (isLogin) {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;

        if (inviteToken) {
          await acceptInvite(inviteToken);
          return;
        }
        navigate("/");
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: inviteToken
              ? `${window.location.origin}/auth?invite=${inviteToken}`
              : window.location.origin,
            data: { display_name: displayName || email },
          },
        });
        if (error) throw error;

        if (data.user && !data.session) {
          toast({
            title: "Check your email",
            description: "We sent you a confirmation link. Please verify your email to continue.",
          });
          return;
        }

        // If auto-confirmed, accept invite
        if (inviteToken) {
          await acceptInvite(inviteToken);
          return;
        }
        navigate("/");
      }
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  if (acceptingInvite) {
    return (
      <div className="dark min-h-screen flex items-center justify-center bg-background p-4">
        <div className="text-center space-y-4">
          <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary" />
          <p className="text-sm text-muted-foreground">Accepting invite...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="dark min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 animate-pulse-glow">
            <span className="text-3xl">🎱</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Magic 8-Ball</h1>
          <p className="text-sm text-muted-foreground">
            {inviteToken ? "You've been invited! Sign in or create an account to join." : "Community sentiment analysis"}
          </p>
        </div>

        <Card className="border-border/50 bg-card/80 backdrop-blur">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg">{isLogin ? "Sign in" : "Create account"}</CardTitle>
            <CardDescription>
              {inviteToken
                ? isLogin
                  ? "Sign in to accept your invitation"
                  : "Create an account to accept your invitation"
                : isLogin
                  ? "Enter your credentials to access your dashboard"
                  : "Create a new account"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {!isLogin && (
                <div className="space-y-2">
                  <Label htmlFor="displayName">Display Name</Label>
                  <Input
                    id="displayName"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Your name"
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  minLength={6}
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Loading..." : isLogin ? "Sign in" : "Create account"}
              </Button>
            </form>
            <div className="mt-4 text-center">
              <button
                type="button"
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setIsLogin(!isLogin)}
              >
                {isLogin ? "Need an account? Sign up" : "Already have an account? Sign in"}
              </button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
