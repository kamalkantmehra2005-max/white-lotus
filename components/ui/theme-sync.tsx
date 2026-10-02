"use client";

import { useTheme } from "next-themes";
import { useEffect, useRef } from "react";

/** Applies the theme saved in the account (Settings → Theme) on a new device, once per page load. */
export function ThemeSync({ theme }: { theme: string | null }) {
  const { setTheme } = useTheme();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !theme) return;
    done.current = true;
    let local: string | null = null;
    try {
      local = localStorage.getItem("theme");
    } catch {
      /* storage unavailable */
    }
    if (!local) setTheme(theme);
  }, [theme, setTheme]);
  return null;
}
