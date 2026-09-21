import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspacePrefetchIntent } from "./workspace-prefetch";

describe("workspace prefetch intent", () => {
  afterEach(() => vi.useRealTimers());

  it("cancels a speculative load when the pointer or focus leaves early", () => {
    vi.useFakeTimers();
    const prefetch = vi.fn();
    const intent = createWorkspacePrefetchIntent(prefetch, 180);

    intent.schedule("warehouse");
    vi.advanceTimersByTime(100);
    intent.cancel("warehouse");
    vi.advanceTimersByTime(200);

    expect(prefetch).not.toHaveBeenCalled();
  });

  it("starts one preload only after an uninterrupted intent", () => {
    vi.useFakeTimers();
    const prefetch = vi.fn();
    const intent = createWorkspacePrefetchIntent(prefetch, 180);

    intent.schedule("hr");
    vi.advanceTimersByTime(100);
    intent.schedule("hr");
    vi.advanceTimersByTime(179);
    expect(prefetch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(prefetch).toHaveBeenCalledExactlyOnceWith("hr");
  });

  it("clears every pending preload when the workspace shell unmounts", () => {
    vi.useFakeTimers();
    const prefetch = vi.fn();
    const intent = createWorkspacePrefetchIntent(prefetch, 180);

    intent.schedule("hr");
    intent.schedule("reports");
    intent.cancelAll();
    vi.advanceTimersByTime(200);

    expect(prefetch).not.toHaveBeenCalled();
  });
});
