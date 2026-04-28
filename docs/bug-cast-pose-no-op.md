# Bug: `/cast/pose` silently no-ops — requires CAMERA mode but never enters it

**Status:** fixed 2026-04-28 — `Session.sendPose` now calls `ensureInputForwarding` before each POSE message, so the CAMERA-mode handshake runs once on the first pose send. The Quest-2 platform limitation documented under "Workaround — DOES NOT WORK on Quest 2" below is still open as a downstream / hardware concern.
**Discovered:** 2026-04-23 (reported from a downstream consumer in `bevy_xr_nitro`)

## Symptom

Calling `/cast/pose { yaw: 3.1416 }` returns `{ok: true}`. `/cast/status` confirms
`pose: { yaw: 3.1416, yaw_deg: 180, pose_loop: true }`. But `/cast/screenshot`
shows an unchanged view — the cast still streams the user's current HMD
perspective. The pose offset has zero visible effect.

Repro (Quest 2, but almost certainly also Quest 3):

```
quest-dev start
quest-dev deploy <some-xr-apk>
curl -X POST http://localhost:8092/cast/start -d '{"resolution":"720p"}'
curl -X POST http://localhost:8092/cast/pose -d '{"yaw": 3.14159}'
curl -o frame.jpg http://localhost:8092/cast/screenshot
# frame.jpg is the user's live view — yaw ignored
```

`/cast/layers` during the session confirms the active layer is
`type: 1 EYE_BUFFER` from `com.oculus.magicislandcastingservice` — the
compositor's live eye buffer, not a virtual camera.

## Root cause

The Quest's cast pipeline has two input-forwarding modes:

- **`INPUT_FWD_STATE = 0` (normal):** captures the compositor eye buffer
  directly. Pose offsets are ignored because the eye buffer is rendered
  from the real HMD pose.
- **`INPUT_FWD_STATE = 1` (camera):** activates the VirtualCamera layer.
  Pose offsets from the `POSE` wire message (type 0 = VIRTUAL_CAMERA) are
  honored.

`/cast/pose`'s handler at `src/daemon/server.ts:456-495` sends the POSE
wire message via `session.setPoseOffset()` / `session.applyPoseDelta()` →
`session.sendPose()` (`src/cast/session.ts:570-580`), but **never** asks
the Quest to enter CAMERA mode. It also auto-starts the 27 Hz pose loop,
which is necessary but not sufficient — the loop just spams the same POSE
message the Quest continues to ignore.

The mode switch exists — `session.ensureInputForwarding()` at
`src/cast/session.ts:648-659` sends the full sequence:
```ts
buildSetProperty("input_forwarding_gaze_click", "true")
buildInputForwardingState(1)       // ← CAMERA mode
buildStartInputForwarding()
buildActivateLayer(layerId)
```
— but it is called only from `/cast/gaze`'s `action: "enable"` and
`action: "click"` branches (`server.ts:511, 516`). `/cast/pose` does not
call it, so the Quest stays in INPUT_FWD_STATE=0.

## Evidence

- Handler without the mode switch: `src/daemon/server.ts:456-495`.
- `sendPose` auto-starts the pose loop but does nothing about mode:
  `src/cast/session.ts:570-580`.
- `ensureInputForwarding()` is the missing prerequisite:
  `src/cast/session.ts:648-659`.
- `buildPose` wire message writes `type=0` (VIRTUAL_CAMERA):
  `packages/cast2-protocol/src/mud.ts:122-137`.
- Protocol doc for pose types:
  `packages/cast2-protocol/docs/protocol.md:319-346`.
- Protocol doc for `INPUT_FWD_STATE` semantics:
  `packages/cast2-protocol/docs/protocol.md:384` (0=normal, 1=camera).
- Feature flag couples gaze-click to VirtualCamera pose:
  `packages/cast2-protocol/docs/feature-flags.md:16` —
  *"Gaze-based click via VirtualCamera pose"*.
- Comment in `sendPose` is misleading about what's needed:
  ```ts
  // Auto-start periodic pose loop on first pose send so the Quest
  // accepts our camera override (requires continuous ~27 Hz updates).
  ```
  Frequency is real; the mode switch is also real and also required.

## Fix

Small. Two equivalent options:

**A.** Call `ensureInputForwarding()` in the `/cast/pose` handler before
`setPoseOffset` / `applyPoseDelta`. Mirrors `/cast/gaze`:

```ts
// server.ts:468 (before "setPoseOffset")
session.ensureInputForwarding();
```

**B.** Call `ensureInputForwarding()` from `sendPose()` itself the first
time, alongside the existing auto-start of the pose loop:

```ts
// session.ts:570
sendPose(pose: PoseState): void {
  this._pose = pose;
  if (this._connected && this.subMagic) {
    this.ensureInputForwarding();              // NEW
    this.sendXrsp(buildPose(this.subMagic, this.nextSeq(), this._pose));
  }
  if (!this._poseLoopActive) {
    this.startPoseLoop();
  }
}
```

Option B is slightly preferable — it also covers `applyPoseDelta` in
isolation and future callers that bypass the HTTP handler. Downside: it
couples `sendPose` to the input-forwarding state machine, which the
module's existing split arguably wants separate.

## Workaround — DOES NOT WORK on Quest 2

Expected workaround: call `/cast/gaze { action: "enable" }` before
`/cast/pose`. `enable` calls `ensureInputForwarding()`, which sends the
wire sequence to flip INPUT_FWD_STATE to 1 and activate the VirtualCamera
layer. Subsequent pose sends should then take effect.

**Tested 2026-04-23 on Quest 2 — the workaround does not produce a
rotated frame.** Repro (after a fresh `/cast/stop` + `/cast/start`):

```
curl -X POST http://localhost:8092/cast/gaze   -d '{"action":"enable"}'  # ok
curl -X POST http://localhost:8092/cast/pose   -d '{"yaw": 3.14159}'     # ok
curl     -s  http://localhost:8092/cast/layers                           # still EYE_BUFFER
curl -o frame.jpg http://localhost:8092/cast/screenshot                  # user's view, unchanged
```

`/cast/layers` still reports the active layer as
`type: 1 EYE_BUFFER` from `com.oculus.magicislandcastingservice`. The
VirtualCamera layer never activates.

Possible reasons (unverified — Quest 3 not tested this session):

1. Quest 2's casting service may not expose a VirtualCamera layer at
   all. The feature may be Quest-3-only / MQDH-only.
2. The app itself may need to render a secondary-camera view pass for
   VirtualCamera to have something to composite. An arbitrary Bevy
   OpenXR app doesn't set up a secondary view; only apps built against
   Meta's API for companion cameras would.
3. `ensureInputForwarding` may be silently failing on Quest 2 at the
   wire level — the handler returns `ok: true` before checking that the
   Quest accepted the state change.

If (1) or (2) is the cause, this is a Quest-2 / app-side limitation
rather than a quest-dev bug — quest-dev's fix still stands (`/cast/pose`
*should* call `ensureInputForwarding`, for consistency with `/cast/gaze`
and so that Quest 3 + VirtualCamera-aware apps Just Work), but the
observable symptom reported above isn't purely a quest-dev bug.

**Verification still needed:** reproduce on Quest 3 with an
MQDH-generation companion-camera app. If the same "EYE_BUFFER persists
after `ensureInputForwarding`" is observed there, the bug is deeper in
the protocol handshake, not in the handler ordering.

## Scope

- Bug is platform-agnostic — same code path on Quest 2 and Quest 3. The
  Quest 2 origin of this report was coincidental.
- `pose-loop` / `setPoseOffset` / `applyPoseDelta` all funnel through
  `sendPose`, so all three have the same bug surface.
- `/cast/gaze` is unaffected because it explicitly calls
  `ensureInputForwarding` already.

## Related

- Reported from: `bevy_xr_nitro` (benchmark demo redesign), trying to
  verify a branding-logo quad composition layer placed 5 m behind the
  user's spawn pose.
- Downstream confirmation log for this environment:
  `com.oculus.magicislandcastingservice` listed as the active cast
  source after a `/cast/start` — consistent with INPUT_FWD_STATE=0.
