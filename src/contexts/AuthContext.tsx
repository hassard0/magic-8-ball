import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";

type Profile = Tables<"profiles">;
type UserRole = Tables<"user_roles">;

interface AuthContextType {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  userRole: UserRole | null;
  isAdmin: boolean;
  orgId: string | null;
  loading: boolean;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [loading, setLoading] = useState(true);

  const provisionOrg = async (userId: string, orgName: string) => {
    const { data: org, error: orgError } = await supabase
      .from("organizations")
      .insert({ name: orgName })
      .select()
      .single();
    if (orgError) throw orgError;

    await supabase
      .from("profiles")
      .update({ org_id: org.id })
      .eq("user_id", userId);

    await supabase
      .from("user_roles")
      .insert({ user_id: userId, org_id: org.id, role: "admin" });

    return org.id;
  };

  const fetchProfile = async (userId: string, userMetadata?: Record<string, any>) => {
    const { data: profileData } = await supabase
      .from("profiles")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    // If user has no org but signed up with one, create it now
    if (profileData && !profileData.org_id && userMetadata?.org_name) {
      try {
        await provisionOrg(userId, userMetadata.org_name);
        // Re-fetch profile after org creation
        const { data: updatedProfile } = await supabase
          .from("profiles")
          .select("*")
          .eq("user_id", userId)
          .maybeSingle();
        setProfile(updatedProfile);
        if (updatedProfile?.org_id) {
          const { data: roleData } = await supabase
            .from("user_roles")
            .select("*")
            .eq("user_id", userId)
            .eq("org_id", updatedProfile.org_id)
            .maybeSingle();
          setUserRole(roleData);
        }
        return;
      } catch (e) {
        console.error("Failed to provision org:", e);
      }
    }

    setProfile(profileData);

    if (profileData?.org_id) {
      const { data: roleData } = await supabase
        .from("user_roles")
        .select("*")
        .eq("user_id", userId)
        .eq("org_id", profileData.org_id)
        .maybeSingle();
      setUserRole(roleData);
    } else {
      setUserRole(null);
    }
  };

  const refreshProfile = async () => {
    if (user) await fetchProfile(user.id);
  };

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        setSession(session);
        setUser(session?.user ?? null);
        if (session?.user) {
          setTimeout(() => fetchProfile(session.user.id, session.user.user_metadata), 0);
        } else {
          setProfile(null);
          setUserRole(null);
        }
        setLoading(false);
      }
    );

    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        fetchProfile(session.user.id, session.user.user_metadata);
      }
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
    setProfile(null);
    setUserRole(null);
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        user,
        profile,
        userRole,
        isAdmin: userRole?.role === "admin",
        orgId: profile?.org_id ?? null,
        loading,
        signOut,
        refreshProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
