import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import SsoLoginPrompt from "../SsoLoginPrompt";
import AuthLanding from "../AuthLanding";
import AuthPanel from "../AuthPanel";
import { resolveLoginSsoPresentation } from "../../domain/sso-entry";
import { resolveLoginEntry } from "../../server/auth-entry";
import { SSO_BINDING_PENDING_COOKIE, SSO_LOGIN_PENDING_COOKIE, SSO_LOGIN_TICKET_COOKIE } from "../../server/sso";
import { getServerAuthUser } from "../../server/target-session";

export const dynamic = "force-dynamic";

type LoginPageProps = {
  searchParams: Promise<{ sso_pending?: string | string[]; sso_local?: string | string[] }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const cookieStore = await cookies();
  const pendingCookie = cookieStore.get(SSO_LOGIN_PENDING_COOKIE)?.value === "1";
  const pendingTicket = cookieStore.get(SSO_LOGIN_TICKET_COOKIE)?.value;
  const pendingQuery = queryHasValue(params.sso_pending, "1");
  const localFallback = queryHasValue(params.sso_local, "1");
  const ssoPresentation = resolveLoginSsoPresentation({
    hasLoginPendingCookie: pendingCookie,
    hasLoginTicket: Boolean(pendingTicket),
    hasPendingQuery: pendingQuery,
    localFallback,
  });

  if (ssoPresentation === "trusted_launch") {
    return <SsoLoginPrompt mode="pending" />;
  }
  if (ssoPresentation === "missing_launch") {
    return <SsoLoginPrompt mode="pending" initialDiagnosticStage="sso_pending_state_missing" />;
  }

  const bindingPending = cookieStore.get(SSO_BINDING_PENDING_COOKIE)?.value === "1";

  const user = await getServerAuthUser();
  const destination = resolveLoginEntry(Boolean(user));
  if (destination) redirect(destination);

  if (ssoPresentation === "direct") {
    return <SsoLoginPrompt mode="direct" />;
  }

  return (
    <AuthLanding bindingPending={bindingPending}>
      <AuthPanel />
    </AuthLanding>
  );
}

function queryHasValue(value: string | string[] | undefined, expected: string): boolean {
  return Array.isArray(value) ? value.includes(expected) : value === expected;
}
