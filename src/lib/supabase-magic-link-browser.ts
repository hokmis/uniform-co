import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

let magicLinkClient: SupabaseClient | null | undefined;

const MAX_COOKIE_CHUNK_SIZE = 3180;
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/**
 * Legacy non-SSO magic links use Supabase's implicit fragment response.
 * SSO no longer uses this browser path: it exchanges the generated hash on
 * the server and redirects directly to /app.
 */
export function getSupabaseMagicLinkBrowserClient(): SupabaseClient | null {
  if (magicLinkClient !== undefined) return magicLinkClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    magicLinkClient = null;
    return magicLinkClient;
  }

  magicLinkClient = createClient(url, anonKey, {
    auth: {
      flowType: "implicit",
      storage: createCookieStorage(),
      storageKey: getAuthStorageKey(url),
    },
  });
  return magicLinkClient;
}

function createCookieStorage() {
  return {
    isServer: false,
    getItem(key: string): string | null {
      const direct = readCookie(key);
      if (direct) return direct;
      const chunks: string[] = [];
      for (let index = 0; ; index += 1) {
        const chunk = readCookie(`${key}.${index}`);
        if (!chunk) break;
        chunks.push(chunk);
      }
      return chunks.length > 0 ? chunks.join("") : null;
    },
    setItem(key: string, value: string): void {
      removeCookieChunks(key);
      const encoded = encodeURIComponent(value);
      if (encoded.length <= MAX_COOKIE_CHUNK_SIZE) {
        writeCookie(key, value);
        return;
      }

      let remaining = encoded;
      let index = 0;
      while (remaining.length > 0) {
        let head = remaining.slice(0, MAX_COOKIE_CHUNK_SIZE);
        const escapePosition = head.lastIndexOf("%");
        if (escapePosition > head.length - 3) head = head.slice(0, escapePosition);
        while (head.length > 0) {
          try {
            writeCookie(`${key}.${index}`, decodeURIComponent(head));
            break;
          } catch {
            head = head.slice(0, -3);
          }
        }
        remaining = remaining.slice(head.length);
        index += 1;
      }
    },
    removeItem(key: string): void {
      removeCookieChunks(key);
    },
  };
}

function getAuthStorageKey(supabaseUrl: string): string {
  return `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
}

function readCookie(name: string): string | null {
  const encodedName = encodeURIComponent(name);
  const entry = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${encodedName}=`));
  if (!entry) return null;
  return decodeURIComponent(entry.slice(encodedName.length + 1));
}

function writeCookie(name: string, value: string): void {
  document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}

function removeCookieChunks(key: string): void {
  const names = [key, ...Array.from({ length: 20 }, (_, index) => `${key}.${index}`)];
  names.forEach((name) => {
    document.cookie = `${encodeURIComponent(name)}=; Path=/; Max-Age=0; SameSite=Lax`;
  });
}
