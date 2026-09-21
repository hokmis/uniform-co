import { describe, expect, it, vi } from "vitest";
import { createOverviewReadAheadCoordinator } from "./overview-read-ahead";

describe("overview read-ahead coordinator", () => {
  it("starts a read immediately without waiting for the separate identity request", async () => {
    let resolveIdentity!: () => void;
    let identityReady = false;
    const identity = new Promise<void>((resolve) => {
      resolveIdentity = () => {
        identityReady = true;
        resolve();
      };
    });
    const read = vi.fn(async () => "overview snapshot");
    const coordinator = createOverviewReadAheadCoordinator<string>();

    const readPromise = coordinator.start("auth-user-a", read);

    expect(identityReady).toBe(false);
    expect(read).toHaveBeenCalledOnce();
    await expect(readPromise).resolves.toBe("overview snapshot");

    resolveIdentity();
    await identity;
  });

  it("shares one in-flight read for the same Auth user", () => {
    const read = vi.fn(() => new Promise<string>(() => undefined));
    const coordinator = createOverviewReadAheadCoordinator<string>();
    const first = coordinator.start("auth-user-a", read);
    const second = coordinator.start("auth-user-a", () => Promise.resolve("duplicate"));

    expect(second).toBe(first);
    expect(read).toHaveBeenCalledOnce();
  });

  it("consumes a read once and never transfers it to another Auth user", async () => {
    const coordinator = createOverviewReadAheadCoordinator<string>();
    const readPromise = coordinator.start("auth-user-a", async () => "private snapshot A");

    expect(coordinator.take("auth-user-b")).toBeNull();
    expect(coordinator.take("auth-user-a")).toBeNull();
    await expect(readPromise).resolves.toBe("private snapshot A");
  });

  it("clears a pending read when its panel owner is discarded", () => {
    const coordinator = createOverviewReadAheadCoordinator<string>();
    const readPromise = coordinator.start("auth-user-a", () => new Promise<string>(() => undefined));

    coordinator.clear("auth-user-a");

    expect(coordinator.take("auth-user-a")).toBeNull();
    expect(readPromise).toBeInstanceOf(Promise);
  });
});
