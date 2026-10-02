"use client";

import { useEffect } from "react";
import { useToast } from "@/components/ui/toast";
import { api, bus } from "@/lib/client/api";

export const CLAIM_KEY = "wl.guestClaim";

/**
 * After a guest signs in or registers (including via Google), move the guest chats into the account.
 * The token is a 15-minute, server-signed value bound to the guest identity — it holds no chat data and
 * sessionStorage is only the hand-off between the guest session and the new account session in this tab.
 */
export function GuestClaim({ isGuest }: { isGuest: boolean }) {
  const toast = useToast();
  useEffect(() => {
    if (isGuest) return;
    let token: string | null = null;
    try {
      token = sessionStorage.getItem(CLAIM_KEY);
      if (token) sessionStorage.removeItem(CLAIM_KEY);
    } catch {
      return;
    }
    if (!token) return;
    api<{ moved: number }>("/api/guest/claim", { method: "POST", json: { token } })
      .then((r) => {
        if (r.moved > 0) {
          toast(`Kept ${r.moved} guest conversation${r.moved === 1 ? "" : "s"} in your account.`);
          bus.emit("conversations:changed");
        }
      })
      .catch(() => toast("Your guest chats couldn't be moved (the guest session may have expired).", "error"));
  }, [isGuest, toast]);
  return null;
}

/** Called from the sign-in / sign-up form while still in the guest session. */
export async function prepareGuestClaim(keep: boolean) {
  try {
    sessionStorage.removeItem(CLAIM_KEY);
    if (!keep) return;
    const r = await api<{ token: string }>("/api/guest/claim-token", { method: "POST" });
    sessionStorage.setItem(CLAIM_KEY, r.token);
  } catch {
    /* keeping chats is best-effort; signing in still works */
  }
}
