"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";
import { IconButton } from "./primitives";

const noop = () => () => {};
/** true on the client, false during SSR — avoids a hydration mismatch without setState-in-effect. */
export const useMounted = () => useSyncExternalStore(noop, () => true, () => false);

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useMounted();
  const dark = mounted && resolvedTheme === "dark";
  return (
    <IconButton label={dark ? "Switch to light theme" : "Switch to dark theme"} onClick={() => setTheme(dark ? "light" : "dark")}>
      {mounted ? dark ? <Sun size={16} /> : <Moon size={16} /> : <span className="h-4 w-4" />}
    </IconButton>
  );
}
