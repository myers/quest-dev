# Bug: casting fails on a USB-attached Quest (`:5555` appended to the serial)

**Status:** fixed on `fix/cast-usb-serial` — `CastSession` now takes the
already-resolved adb device from `CastManager` instead of re-deriving one, and
only runs `adb connect` for TCP targets.
**quest-dev version:** 2.5.0
**Date observed:** 2026-09-02
**Severity:** Medium — casting (and therefore every per-eye/stereo capture) is
unusable over USB; `screenshot` still works, so only VR-content verification is lost.

## Summary

With a Quest attached over USB (no adb-over-wifi), `quest-dev cast-screenshot`
fails immediately:

```
Failed to start cast: Command failed with code 1: adb: device '2G0YC1ZF7V0HP1:5555' not found
```

`2G0YC1ZF7V0HP1` is the USB hardware serial. `:5555` is appended to it
unconditionally, producing a target that does not exist.

## Environment

- One Quest 3, USB only, serial `2G0YC1ZF7V0HP1` (`adb devices` shows
  `2G0YC1ZF7V0HP1  device usb:3-2.2 product:eureka model:Quest_3`).
- No `adb tcpip` / no `192.168.x.x:5555` entry.
- `com.oculus.magicislandcastingservice` already present on the device.

## Reproduce

1. Attach a Quest over USB only; confirm `adb devices` lists a bare serial with
   no `:port` suffix.
2. `quest-dev cast-screenshot ~/somewhere`
3. → `adb: device '<serial>:5555' not found`

## Cause

`CastManager.start()` resolves the device correctly (`src/daemon/cast-manager.ts:120`):

```ts
const adbDevice = getAdbDevice() ?? await this.getAdbSerial() ?? `${questIp}:5555`;
await ensureCastingInstalled(adbDevice);
```

…then throws that value away and passes the *IP* to the session
(`src/daemon/cast-manager.ts:142`), and `CastSession` re-derives a target by
appending `:5555` in two places (`src/cast/session.ts:247`, `:275`):

```ts
const device = `${questIp}:5555`;
```

`getQuestIp()` falls back to the serial when there is no wifi address, so the
serial gets the `:5555` suffix — the one shape adb cannot resolve.

## Fix

- `CastSession.adbSetup()` / `.startCastService()` / `.start()` /
  `.waitForConnections()` take an already-resolved `adbDevice` and use it verbatim.
- `adb connect` runs only when the target is TCP-style (`isTcpTarget()`, now
  exported from `src/utils/adb.ts`) — connecting to a USB serial is both
  meaningless and fatal.
- `CastManager` passes the `adbDevice` it already computed.

## Verification

On the same USB-only Quest 3, after the fix:

```
$ node build/index.js cast-screenshot ~/p/chromium-workspace/screenshots
/home/myers/p/chromium-workspace/screenshots/screenshot-2026-09-02-19-03-11-Z.jpg

$ curl -s http://127.0.0.1:19872/cast/status
{"connected":true,"running":true,"width":1280,"height":720,"frame_count":156,
 "bytes":1894380,"fps":17.8,"elapsed":8.7,"has_frame":true,"eye":"stereo",...}
```

The captured JPEG is a proper side-by-side stereo pair with visible per-eye
parallax. `pnpm run build` clean, `pnpm test` 198/198 passing.

## Note for callers

The first `cast-screenshot` after a cold start can return
`HTTP 503 {"error":"no frame available"}` — casting has begun but no frame has
arrived yet. Retrying a few seconds later succeeds. Worth a short internal
retry/wait rather than surfacing the 503.

---

## Follow-up: cold-start cast delivers zero frames (NOT fixed)

**Status:** open, reproducible, workaround known.
**quest-dev version:** 2.5.0 + the USB-serial fix above.
**Date observed:** 2026-09-03, Quest 3 over USB.

Separate from the `:5555` bug. With the serial fix in place, `adb` resolves and
the cast session reports `connected: true` — but the first `/cast/start` after a
daemon starts delivers **no frames at all**:

```
{"connected":true,"running":true,"frame_count":0,"fps":0,"has_frame":false}
```

`cast-screenshot` therefore exits with `HTTP 503 {"error":"no frame available"}`.

### Reliable workaround

A stop/start cycle against the **same** daemon always recovers it, and frames
flow immediately afterwards:

```bash
PORT=$(quest-dev device info <serial> --json | grep -oP '"daemonPort":\s*\K[0-9]+')
curl -X POST http://127.0.0.1:$PORT/cast/stop
sleep 3
curl -X POST http://127.0.0.1:$PORT/cast/start
# → connected:true, frame_count climbing, ~21 fps
```

### What did NOT work

Three attempted fixes were tried and reverted, each verified against the repro:

1. **Polling to a deadline** instead of the fixed `setTimeout(1500)` /
   `setTimeout(500)` in `cast-screenshot.ts`. Correct in principle, but it only
   converts a fast confusing 503 into a slow one — frames never arrive within
   any timeout, so this is not the bug.
2. **`POST /cast/restart`** as a self-heal. Reuses the session and leaves it just
   as frameless; not equivalent to stop+start.
3. **`am force-stop com.oculus.magicislandcastingservice`** before
   `am start-foreground-service` in `CastSession.startCastService()`. Made it
   worse: the session then reports `connected: false` and never reconnects,
   consistent with Android's stopped-package broadcast semantics — the
   `...CONNECT` broadcast is not delivered to a force-stopped app.

Most puzzling part, and where the next investigation should start: issuing
`/cast/stop` + `/cast/start` **from inside `castScreenshotCommand` via
`daemonFetch`** does not recover the session, while the byte-identical `curl`
calls against the same endpoints on the same daemon do. That asymmetry is not
explained yet, and is the thread to pull.
