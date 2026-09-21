import { createServerClient, type SetAllCookies } from "@supabase/ssr";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { resolveAuthenticatedEntry } from "./auth-entry";

function getTargetSupabaseConfig(): { url: string; anonKey: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && anonKey ? { url, anonKey } : null;
}

export async function getServerAuthUser(): Promise<User | null> {
  const config = getTargetSupabaseConfig();
  if (!config) return null;

  const cookieStore = await cookies();
  const client = createServerClient(config.url, config.anonKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: Parameters<SetAllCookies>[0]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // A read-only render context can still validate the existing session.
        }
      },
    },
  });

  const { data, error } = await client.auth.getUser();
  return error || !data.user ? null : data.user;
}

export async function requireServerAuthUser(): Promise<User> {
  const user = await getServerAuthUser();
  if (!user) redirect(resolveAuthenticatedEntry(false));
  return user;
}
