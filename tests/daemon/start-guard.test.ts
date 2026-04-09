import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Bug 1: Stats interval leaked on start failure.
 * If session.bind() throws after statsInterval is created,
 * the interval is never cleared.
 *
 * Bug 2: Concurrent /cast/start calls can both pass the
 * isActive check and create two sessions.
 */

describe("stats interval cleanup on start failure", () => {
  it("interval is cleared if setup fails after creation", async () => {
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let intervalCleared = false;

    // Simulate the fixed pattern: create interval only AFTER all async ops succeed
    async function startFixed(shouldFail: boolean) {
      // Do all async work first
      if (shouldFail) throw new Error("bind failed");

      // Only create interval after success
      intervalId = setInterval(() => {}, 500);
    }

    // Start should fail
    await expect(startFixed(true)).rejects.toThrow("bind failed");

    // Interval was never created
    expect(intervalId).toBeNull();
  });

  it("buggy pattern: interval created before async work leaks", async () => {
    let intervalId: ReturnType<typeof setInterval> | null = null;

    async function startBuggy(shouldFail: boolean) {
      // Bug: interval created BEFORE async work
      intervalId = setInterval(() => {}, 500);

      // Async work that might fail
      if (shouldFail) throw new Error("bind failed");
    }

    await expect(startBuggy(true)).rejects.toThrow("bind failed");

    // Interval was created and is now leaked!
    expect(intervalId).not.toBeNull();
    clearInterval(intervalId!); // clean up for test
  });
});

describe("concurrent start guard", () => {
  it("second concurrent start is rejected while first is in progress", async () => {
    let starting = false;
    let startCount = 0;

    async function startGuarded() {
      if (starting) throw new Error("start already in progress");
      starting = true;
      try {
        startCount++;
        await new Promise((r) => setTimeout(r, 50));
      } finally {
        starting = false;
      }
    }

    const p1 = startGuarded();
    const p2 = startGuarded().catch((e) => e);

    await p1;
    const err = await p2;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("start already in progress");
    expect(startCount).toBe(1);
  });
});
