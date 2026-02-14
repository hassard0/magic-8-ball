import { useLocation, useNavigate } from "react-router-dom";
import { LayoutDashboard, MessageSquarePlus, History, Settings, LogOut } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";

const navItems = [
  { label: "Dashboard", icon: LayoutDashboard, path: "/" },
  { label: "Ask Question", icon: MessageSquarePlus, path: "/ask" },
  { label: "History", icon: History, path: "/history" },
];

const adminItems = [
  { label: "Admin", icon: Settings, path: "/admin" },
];

export default function AppSidebar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { isAdmin, profile, signOut } = useAuth();

  const items = isAdmin ? [...navItems, ...adminItems] : navItems;

  return (
    <aside className="fixed left-0 top-0 z-30 flex h-screen w-56 flex-col border-r border-sidebar-border bg-sidebar">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-5 py-5 border-b border-sidebar-border">
        <span className="text-2xl">🎱</span>
        <span className="font-semibold text-sm text-sidebar-foreground tracking-tight">Magic 8-Ball</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {items.map((item) => {
          const active = pathname === item.path;
          return (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* User */}
      <div className="border-t border-sidebar-border px-3 py-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-sidebar-foreground truncate max-w-[140px]">
            {profile?.display_name || "User"}
          </span>
          <button
            onClick={signOut}
            className="p-1.5 rounded-md text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors"
            title="Sign out"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
}
