# Bug: `quest-dev deploy --device` ignored when multiple devices connected

**Status:** fixed 2026-04-28 — daemon now publishes its bound device in `daemon.json`; `ensureDaemon` rejects `--device` requests that conflict with the bound device, with a clear error pointing the user at `quest-dev stop` followed by retry.
**quest-dev version:** 2.0.0
**Date observed:** 2026-04-18
**Severity:** High — silently deploys to wrong device

## Summary

When two Quest devices are simultaneously connected via `adb`, `quest-dev
deploy --device <ip>` ignores the `--device` flag and installs/launches
on the *other* device. There is no warning that the flag was disregarded.

## Environment

- Two Quests connected over ADB-TCP:
  - Quest 2: `192.168.42.152:5555`
  - Quest 3: `192.168.42.151:5555`
- Daemon (`quest-dev start`) was already running, presumably bound to
  Quest 2 from a prior session.
- No `.quest-dev.json` `device` field set.

## Reproduce

1. Connect two Quests:
   ```
   adb connect 192.168.42.152:5555
   adb connect 192.168.42.151:5555
   adb devices
   # Both should show "device"
   ```
2. Start daemon implicitly via an earlier deploy targeting `.152` (or
   no `--device`).
3. Now run:
   ```
   quest-dev deploy --device 192.168.42.151 path/to/app.apk
   ```
4. Output reports `Deploy successful: <package> is running` — but check
   actual install location:
   ```
   adb -s 192.168.42.151:5555 shell pm list packages | grep <pkg>
   # → not present
   adb -s 192.168.42.152:5555 shell pidof <pkg>
   # → process running here instead
   ```

The APK was installed on `.152` (the previously-targeted device), and
the launch went there too. The logcat file the deploy command points at
also captures from `.152`.

## Expected behaviour

Either:
- Honour `--device <ip>`: route every `adb` and daemon-internal call to
  that target. Restart or re-bind the daemon if needed.
- Refuse to proceed when the daemon is bound to a different device than
  `--device` requests, with a clear error and a suggested `quest-dev
  stop` step.

Silent fallback to a different device is the dangerous case — the user
sees a green "Deploy successful" message and assumes the build is on the
intended headset.

## Impact

I was validating an A/V sync fix on Quest 2, then asked to revalidate on
Quest 3. The deploy reported success and a logcat path, so I wrote
analysis against that logcat — but the build was still on Quest 2. The
new build was never on Quest 3 at all. Result: 5 minutes of bogus
analysis attributed to the wrong device, plus user time noticing the
discrepancy.

## Workaround

Stop the daemon explicitly before re-targeting:
```
quest-dev stop
adb disconnect 192.168.42.152:5555  # remove the unwanted device entirely
quest-dev deploy --device 192.168.42.151 path/to/app.apk
```

Or set the device persistently:
```
quest-dev config --device 192.168.42.151
```
(Untested in this scenario — may also be ignored if the daemon is
already bound elsewhere.)

## Suggested fix areas

- `quest-dev deploy` CLI handler: pass `--device` through to the
  daemon's `/install` and `/launch` calls explicitly, not via cached
  state.
- Daemon: track and log the active device on every operation; reject
  requests whose `--device` differs from the bound one with HTTP 409
  rather than serving them against the bound device.
- `adb` invocations: always use `adb -s <ip>` rather than relying on
  ADB's "single device" default — that default is what silently picks
  the wrong target when two are connected.
