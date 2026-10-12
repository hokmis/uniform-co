import { afterEach, describe, expect, it, vi } from "vitest";
import { getInventoryDataRevision, notifyInventoryDataChanged, subscribeToInventoryDataChanges } from "./inventory-events";

describe("inventory data change notifications", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("notifies active readers and stops notifying after unsubscribe", () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const initialRevision = getInventoryDataRevision();
    const listener = vi.fn();
    const unsubscribe = subscribeToInventoryDataChanges(listener);

    notifyInventoryDataChanged();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getInventoryDataRevision()).toBe(initialRevision + 1);

    unsubscribe();
    notifyInventoryDataChanged();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("is safe to subscribe and notify during server rendering", () => {
    vi.stubGlobal("window", undefined);
    const initialRevision = getInventoryDataRevision();

    expect(() => subscribeToInventoryDataChanges(() => undefined)()).not.toThrow();
    expect(() => notifyInventoryDataChanged()).not.toThrow();
    expect(getInventoryDataRevision()).toBe(initialRevision);
  });
});
