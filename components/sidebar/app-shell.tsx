"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { PanelLeft } from "lucide-react";
import { Sidebar } from "./sidebar";
import { IconButton } from "@/components/ui/primitives";
import { cn } from "@/lib/client/cn";
import { GuestClaim } from "@/components/guest/guest-claim";

export type ShellUser = { name: string | null; email: string; role: "user" | "admin"; isGuest: boolean; guestExpiresAt: string | null };
const ShellCtx = createContext<{ toggle: () => void; open: boolean; user: ShellUser; guestRetentionHours: number }>({
  toggle: () => {},
  open: true,
  user: { name: null, email: "", role: "user", isGuest: false, guestExpiresAt: null },
  guestRetentionHours: 24,
});
export const useShell = () => useContext(ShellCtx);

export function AppShell({ user, guestRetentionHours = 24, children }: { user: ShellUser; guestRetentionHours?: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const apply = () => {
      setIsMobile(mq.matches);
      let saved: string | null = null;
      try {
        saved = localStorage.getItem("wl.sidebar");
      } catch {
        /* storage unavailable */
      }
      setOpen(mq.matches ? false : saved !== "closed");
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const toggle = useCallback(() => {
    setOpen((o) => {
      if (!isMobile) {
        try {
          localStorage.setItem("wl.sidebar", o ? "closed" : "open");
        } catch {
          /* ignore */
        }
      }
      return !o;
    });
  }, [isMobile]);

  // Keyboard: Ctrl/Cmd+Shift+S toggles the sidebar
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return (
    <ShellCtx.Provider value={{ toggle, open, user, guestRetentionHours }}>
      <GuestClaim isGuest={user.isGuest} />
      <div className="flex h-dvh overflow-hidden bg-bg">
        {isMobile && open && <div className="fixed inset-0 z-30 bg-black/40" onClick={toggle} aria-hidden />}
        <aside
          className={cn(
            "z-40 flex h-full shrink-0 flex-col border-r border-border bg-surface transition-[width,transform] duration-200",
            isMobile ? "fixed inset-y-0 left-0 w-[280px]" : open ? "w-[272px]" : "w-0 overflow-hidden border-r-0",
            isMobile && !open && "-translate-x-full",
          )}
          aria-label="Sidebar"
        >
          <Sidebar user={user} onNavigate={() => isMobile && setOpen(false)} onCollapse={toggle} />
        </aside>
        <div className="relative flex min-w-0 flex-1 flex-col">
          {!open && (
            <div className="absolute left-2 top-2 z-20">
              <IconButton label="Open sidebar" onClick={toggle}>
                <PanelLeft size={18} />
              </IconButton>
            </div>
          )}
          {children}
        </div>
      </div>
    </ShellCtx.Provider>
  );
}
