"use client";

import { useEffect, useRef, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { accountBindingResumePayload } from "@/src/domain/sso-entry";
import { getSupabaseBrowserClient } from "@/src/lib/supabase-browser";

export function useAuthSession() {
  const client = getSupabaseBrowserClient();
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(Boolean(client));
  const bindingResumeInFlight = useRef(false);

  useEffect(() => {
    if (!client) return;

    let active = true;

    async function resumePendingBinding() {
      if (bindingResumeInFlight.current || !document.cookie.split("; ").some((cookie) => cookie === "uniform_sso_binding_pending=1")) return;
      bindingResumeInFlight.current = true;
      try {
        const response = await fetch("/api/sso-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(accountBindingResumePayload()),
        });
        if (response.redirected && response.url) window.location.replace(response.url);
      } catch {
        // The short-lived ticket remains available for a fresh auth-state event.
      } finally {
        bindingResumeInFlight.current = false;
      }
    }

    // The subscription emits INITIAL_SESSION after Auth initializes, so this is
    // the single source for both the first render decision and later changes.
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      setSession(session ?? null);
      setUser(session?.user ?? null);
      setLoading(false);
      if (session) void resumePendingBinding();
    });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [client]);

  return { client, session, user, loading };
}
