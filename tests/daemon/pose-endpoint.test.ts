import { describe, expect, it } from "vitest";
import { createPoseState, updatePose, setPoseOffset, type PoseState } from "@myerscarpenter/cast2-protocol";

/**
 * Simulates the /cast/pose endpoint logic:
 * offset and delta should be mutually exclusive.
 */
function applyPoseRequest(
  state: PoseState,
  data: Record<string, number>,
): PoseState {
  // Direct offset — takes priority
  if ("x" in data || "y" in data || "z" in data || "yaw" in data || "pitch" in data) {
    return setPoseOffset(state, {
      x: data.x,
      y: data.y,
      z: data.z,
      yaw: data.yaw,
      pitch: data.pitch,
    });
  }
  // Incremental deltas — only if no offset fields present
  if ("dx" in data || "dy" in data || "dz" in data || "d_yaw" in data || "d_pitch" in data) {
    return updatePose(state, {
      dForward: data.dz ?? 0,
      dStrafe: data.dx ?? 0,
      dUp: data.dy ?? 0,
      dYaw: data.d_yaw ?? 0,
      dPitch: data.d_pitch ?? 0,
    });
  }
  return state;
}

describe("/cast/pose endpoint logic", () => {
  it("applies offset when offset fields provided", () => {
    const state = createPoseState();
    const result = applyPoseRequest(state, { x: 1.0, y: 2.0 });
    expect(result.x).toBeCloseTo(1.0);
    expect(result.y).toBeCloseTo(2.0);
  });

  it("applies delta when delta fields provided", () => {
    const state = createPoseState();
    const result = applyPoseRequest(state, { dz: 0.3 }); // forward
    expect(result.z).toBeCloseTo(-0.3); // OpenXR: forward = -Z
  });

  it("does not double-apply when both offset and delta provided", () => {
    const state = createPoseState();
    // If both are present, offset wins — delta is NOT also applied
    const result = applyPoseRequest(state, { x: 1.0, dz: 0.3 });
    expect(result.x).toBeCloseTo(1.0);
    // z should be 0 (offset only set x, delta was ignored)
    expect(result.z).toBeCloseTo(0);
  });

  it("returns unchanged state when no recognized fields", () => {
    const state = createPoseState();
    const result = applyPoseRequest(state, { foo: 42 } as any);
    expect(result).toBe(state);
  });
});
