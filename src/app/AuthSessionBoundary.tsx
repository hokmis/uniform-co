"use client";

import { Fragment, type ReactNode, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "@/src/lib/supabase-browser";

type Props = { children: ReactNode };

export default function AuthSessionBoundary({ children }: Props) {
  const client = getSupabaseBrowserClient();
  const [sessionKey, setSessionKey] = useState("anonymous");

  useEffect(() => {
    if (!client) return;

    let active = true;
    void client.auth.getSession().then(({ data }) => {
      if (active) setSessionKey(data.session?.user.id ?? "anonymous");
    });

    const { data } = client.auth.onAuthStateChange((_event, session) => {
      setSessionKey(session?.user.id ?? "anonymous");
    });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [client]);

  return <Fragment key={sessionKey}>{children}</Fragment>;
}
