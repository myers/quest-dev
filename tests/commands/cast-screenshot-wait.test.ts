import { describe, expect, it, vi } from "vitest";

/**
 * Regression: cast-screenshot used a fixed sleep and then fetched
 * /cast/screenshot once, so a session that had just (re)started under it
 * answered 503 "no frame available" and the command exited 1.
 */

const daemonFetch = vi.fn();
vi.mock("../../src/daemon/client.js", () => ({
  daemonFetch,
  ensureDaemon: vi.fn(),
}));

const { waitForFrame } = await import("../../src/commands/cast-screenshot.js");
const info = { port: 1234 } as never;

describe("waitForFrame", () => {
  it("polls until the decoder reports a frame", async () => {
    daemonFetch
      .mockResolvedValueOnce({ has_frame: false })
      .mockResolvedValueOnce({ has_frame: false })
      .mockResolvedValueOnce({ has_frame: true });

    await waitForFrame(info, 5000);

    expect(daemonFetch).toHaveBeenCalledTimes(3);
    expect(daemonFetch).toHaveBeenCalledWith(info, "/cast/status");
  });

  it("gives up after the deadline instead of hanging", async () => {
    daemonFetch.mockReset();
    daemonFetch.mockResolvedValue({ has_frame: false });

    await waitForFrame(info, 0);

    expect(daemonFetch).toHaveBeenCalledTimes(1);
  });
});
