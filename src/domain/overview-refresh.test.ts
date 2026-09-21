import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  mergeOverviewReloadScope,
  overviewReadKeysForScope,
  overviewReadPlanForScope,
  overviewReadPresentation,
} from "./overview-refresh";

describe("overview refresh scope", () => {
  it("keeps each event tied to the summaries it can change", () => {
    expect(overviewReadKeysForScope("inventory")).toEqual(["availability", "receipts", "distributions"]);
    expect(overviewReadKeysForScope("workflow")).toEqual(["availability", "hrRequests", "shipments", "distributions", "audit"]);
    expect(overviewReadKeysForScope("all")).toHaveLength(6);
  });

  it("merges same-tick inventory and workflow events into one complete refresh", () => {
    expect(mergeOverviewReloadScope(null, "inventory")).toBe("inventory");
    expect(mergeOverviewReloadScope("inventory", "inventory")).toBe("inventory");
    expect(mergeOverviewReloadScope("inventory", "workflow")).toBe("all");
    expect(mergeOverviewReloadScope("workflow", "inventory")).toBe("all");
  });

  it("does not let low-priority activity views block the actionable dashboard", () => {
    expect(overviewReadPlanForScope("all")).toEqual({
      primary: ["availability", "hrRequests", "shipments", "receipts"],
      deferred: ["distributions", "audit"],
    });
    expect(overviewReadPlanForScope("inventory")).toEqual({
      primary: ["availability", "receipts"],
      deferred: ["distributions"],
    });
  });

  it("keeps same-account core metrics visible while a refresh runs in the background", () => {
    expect(overviewReadPresentation({
      hasSession: true,
      identityReady: true,
      identityError: false,
      hasCurrentSnapshot: true,
      coreLoading: true,
      deferredLoading: false,
    })).toEqual({
      showCorePlaceholder: false,
      coreRefreshing: true,
      showActivityPlaceholder: false,
      busy: true,
    });
  });

  it("does not replace core metrics with placeholders while only deferred activity loads", () => {
    expect(overviewReadPresentation({
      hasSession: true,
      identityReady: true,
      identityError: false,
      hasCurrentSnapshot: true,
      coreLoading: false,
      deferredLoading: true,
    })).toEqual({
      showCorePlaceholder: false,
      coreRefreshing: false,
      showActivityPlaceholder: true,
      busy: true,
    });
  });

  it("shows placeholders until the first account-bound snapshot and deferred activity are ready", () => {
    expect(overviewReadPresentation({
      hasSession: true,
      identityReady: true,
      identityError: false,
      hasCurrentSnapshot: false,
      coreLoading: true,
      deferredLoading: true,
    })).toEqual({
      showCorePlaceholder: true,
      coreRefreshing: false,
      showActivityPlaceholder: true,
      busy: true,
    });
  });

  it("does not show empty totals as zero after the current identity read fails", () => {
    expect(overviewReadPresentation({
      hasSession: true,
      identityReady: false,
      identityError: true,
      hasCurrentSnapshot: false,
      coreLoading: false,
      deferredLoading: false,
    })).toEqual({
      showCorePlaceholder: true,
      coreRefreshing: false,
      showActivityPlaceholder: true,
      busy: false,
    });
  });

  it("wires the overview cards to the refresh presentation instead of masking snapshots", () => {
    const source = readFileSync("src/app/OverviewDashboard.tsx", "utf8");

    expect(source).toContain("overviewReadPresentation({");
    expect(source).toContain("readPresentation.showCorePlaceholder");
    expect(source).toContain("readPresentation.showActivityPlaceholder");
    expect(source).toContain("readPresentation.coreRefreshing");
  });
});
