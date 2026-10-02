"use client";

import { useEffect } from "react";

/** Registers the service worker (installable app + offline notice). Needs https or http://127.0.0.1. */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      /* not fatal: the site works without it */
    });
  }, []);
  return null;
}
