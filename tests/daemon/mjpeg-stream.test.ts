import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * MJPEG stream cleanup logic.
 * Bug: interval can fire after reply.raw.end() if session stops
 * and client hasn't disconnected yet.
 */

interface FakeResponse {
  writeHead: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  ended: boolean;
}

function createFakeResponse(): FakeResponse {
  const res: FakeResponse = {
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn(() => { res.ended = true; }),
    ended: false,
  };
  return res;
}

/**
 * Fixed MJPEG stream loop: checks `ended` before writing,
 * and wraps writes in try-catch.
 */
function startMjpegStream(
  res: FakeResponse,
  getSession: () => { running: boolean; getScreenshot: () => Buffer | null } | null,
  onCleanup: () => void,
): { interval: ReturnType<typeof setInterval>; cleanup: () => void } {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(interval);
    try { res.end(); } catch { /* ignore */ }
    onCleanup();
  };

  const interval = setInterval(() => {
    const s = getSession();
    if (!s?.running) {
      cleanup();
      return;
    }
    if (res.ended) {
      cleanup();
      return;
    }
    const jpeg = s.getScreenshot();
    if (jpeg) {
      try {
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
        res.write(jpeg);
        res.write("\r\n");
      } catch {
        cleanup();
      }
    }
  }, 50);

  return { interval, cleanup };
}

describe("MJPEG stream cleanup", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("writes frames while session is running", () => {
    const res = createFakeResponse();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const session = { running: true, getScreenshot: () => jpeg };
    const cleanupFn = vi.fn();

    startMjpegStream(res, () => session, cleanupFn);
    vi.advanceTimersByTime(100);

    expect(res.write).toHaveBeenCalled();
    expect(cleanupFn).not.toHaveBeenCalled();
  });

  it("cleans up when session stops", () => {
    const res = createFakeResponse();
    const session = { running: true, getScreenshot: () => Buffer.from([1]) };
    const cleanupFn = vi.fn();

    startMjpegStream(res, () => session, cleanupFn);
    vi.advanceTimersByTime(50);

    session.running = false;
    vi.advanceTimersByTime(100);

    expect(res.end).toHaveBeenCalled();
    expect(cleanupFn).toHaveBeenCalledOnce();
  });

  it("does not write after cleanup", () => {
    const res = createFakeResponse();
    const session = { running: true, getScreenshot: () => Buffer.from([1]) };
    const cleanupFn = vi.fn();

    const { cleanup } = startMjpegStream(res, () => session, cleanupFn);

    // Simulate client disconnect
    cleanup();
    res.write.mockClear();

    vi.advanceTimersByTime(200);

    // No more writes after cleanup
    expect(res.write).not.toHaveBeenCalled();
  });

  it("cleanup is idempotent", () => {
    const res = createFakeResponse();
    const session = { running: true, getScreenshot: () => Buffer.from([1]) };
    const cleanupFn = vi.fn();

    const { cleanup } = startMjpegStream(res, () => session, cleanupFn);

    cleanup();
    cleanup();
    cleanup();

    expect(res.end).toHaveBeenCalledOnce();
    expect(cleanupFn).toHaveBeenCalledOnce();
  });

  it("handles write errors gracefully", () => {
    const res = createFakeResponse();
    res.write.mockImplementation(() => { throw new Error("broken pipe"); });
    const session = { running: true, getScreenshot: () => Buffer.from([1]) };
    const cleanupFn = vi.fn();

    startMjpegStream(res, () => session, cleanupFn);
    vi.advanceTimersByTime(100);

    expect(cleanupFn).toHaveBeenCalledOnce();
  });
});
