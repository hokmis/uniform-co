export type OverviewReloadScope = "all" | "inventory" | "workflow";

export type OverviewReadKey =
  | "availability"
  | "hrRequests"
  | "shipments"
  | "receipts"
  | "distributions"
  | "audit";

export type OverviewReadPlan = {
  primary: readonly OverviewReadKey[];
  deferred: readonly OverviewReadKey[];
};

export type OverviewReadPresentationInput = {
  hasSession: boolean;
  identityReady: boolean;
  identityError: boolean;
  hasCurrentSnapshot: boolean;
  coreLoading: boolean;
  deferredLoading: boolean;
};

export type OverviewReadPresentation = {
  showCorePlaceholder: boolean;
  coreRefreshing: boolean;
  showActivityPlaceholder: boolean;
  busy: boolean;
};

const allReadKeys: readonly OverviewReadKey[] = [
  "availability",
  "hrRequests",
  "shipments",
  "receipts",
  "distributions",
  "audit",
];

const inventoryReadKeys: readonly OverviewReadKey[] = [
  "availability",
  "receipts",
  "distributions",
];

const workflowReadKeys: readonly OverviewReadKey[] = [
  "availability",
  "hrRequests",
  "shipments",
  "distributions",
  "audit",
];

const deferredReadKeys: readonly OverviewReadKey[] = ["distributions", "audit"];

/**
 * Keep the dashboard's read scope explicit. Inventory transactions also alter
 * receipt progress or employee distribution summaries, while workflow events
 * alter reservations, shipment queues, distribution history, and audit feed.
 */
export function overviewReadKeysForScope(scope: OverviewReloadScope): readonly OverviewReadKey[] {
  if (scope === "inventory") return inventoryReadKeys;
  if (scope === "workflow") return workflowReadKeys;
  return allReadKeys;
}

/**
 * Keep the first dashboard paint focused on actionable queues and current
 * stock/receipt totals. Activity history is useful context, but must not block
 * the operator from starting work when its reporting view is slower.
 */
export function overviewReadPlanForScope(scope: OverviewReloadScope): OverviewReadPlan {
  const requested = overviewReadKeysForScope(scope);
  return {
    primary: requested.filter((key) => !deferredReadKeys.includes(key)),
    deferred: requested.filter((key) => deferredReadKeys.includes(key)),
  };
}

/**
 * Keep a same-account core snapshot visible during revalidation. Placeholders
 * are reserved for data that has not loaded yet, and identity failures never
 * leave the dashboard announced as busy forever.
 */
export function overviewReadPresentation(input: OverviewReadPresentationInput): OverviewReadPresentation {
  const waitingForIdentity = input.hasSession && !input.identityError && !input.identityReady;
  const waitingForCoreSnapshot = input.hasSession && !input.identityError && input.identityReady && !input.hasCurrentSnapshot;
  const coreRefreshing = input.hasSession
    && !input.identityError
    && input.identityReady
    && input.hasCurrentSnapshot
    && input.coreLoading;
  const showActivityPlaceholder = input.hasSession
    && (input.identityError || waitingForIdentity || waitingForCoreSnapshot || input.deferredLoading);

  return {
    showCorePlaceholder: input.hasSession && (input.identityError || waitingForIdentity || waitingForCoreSnapshot),
    coreRefreshing,
    showActivityPlaceholder,
    busy: !input.identityError && (waitingForIdentity || waitingForCoreSnapshot || coreRefreshing || showActivityPlaceholder),
  };
}

/**
 * Collapse events emitted by one user action before the next render. An
 * inventory and workflow event together cover the complete dashboard read set.
 */
export function mergeOverviewReloadScope(
  current: OverviewReloadScope | null,
  next: OverviewReloadScope,
): OverviewReloadScope {
  if (!current || current === next) return next;
  if (current === "all" || next === "all" || current !== next) return "all";
  return current;
}
