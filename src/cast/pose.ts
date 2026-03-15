/**
 * Pose state management: euler-to-quaternion conversion, incremental updates,
 * and screen-to-yaw/pitch mapping.
 *
 * All pose coordinates are offsets from the headset's position at the time
 * casting started — they are NOT absolute world-space coordinates.  The origin
 * (0, 0, 0) corresponds to the headset's initial position; moving the pose
 * shifts the virtual camera relative to that starting point.
 */

import type { PoseOffset, PoseDelta, PoseState } from "./protocol/types.js";

/** Create a default pose state (identity orientation, zero offset from headset). */
export function createPoseState(): PoseState {
  return {
    x: 0, y: 0, z: 0,
    qw: 1, qx: 0, qy: 0, qz: 0,
    yaw: 0, pitch: 0,
  };
}

/** Convert yaw/pitch (radians) to quaternion (w, x, y, z). */
export function eulerToQuat(yaw: number, pitch: number): {
  qw: number; qx: number; qy: number; qz: number;
} {
  const cy = Math.cos(yaw * 0.5);
  const sy = Math.sin(yaw * 0.5);
  const cp = Math.cos(pitch * 0.5);
  const sp = Math.sin(pitch * 0.5);
  return {
    qw: cy * cp,
    qx: cy * sp,
    qy: sy * cp,
    qz: -sy * sp,
  };
}

/**
 * Apply incremental movement to a pose state.
 * Returns a new PoseState (does not mutate the input).
 */
export function updatePose(state: PoseState, delta: PoseDelta): PoseState {
  const yaw = state.yaw + (delta.dYaw ?? 0);
  const pitch = Math.max(
    -Math.PI / 2,
    Math.min(Math.PI / 2, state.pitch + (delta.dPitch ?? 0)),
  );

  const dForward = delta.dForward ?? 0;
  const dStrafe = delta.dStrafe ?? 0;
  const dUp = delta.dUp ?? 0;

  // Move in the direction we're facing (yaw only, not pitch)
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x = state.x + dForward * sy + dStrafe * cy;
  const y = state.y + dForward * cy - dStrafe * sy;
  const z = state.z + dUp;

  const q = eulerToQuat(yaw, pitch);
  return { x, y, z, ...q, yaw, pitch };
}

/**
 * Set pose offset directly. Only provided fields are updated.
 * Returns a new PoseState.
 */
export function setPoseOffset(state: PoseState, abs: PoseOffset): PoseState {
  const x = abs.x ?? state.x;
  const y = abs.y ?? state.y;
  const z = abs.z ?? state.z;
  const yaw = abs.yaw ?? state.yaw;
  const pitch = abs.pitch ?? state.pitch;
  const q = eulerToQuat(yaw, pitch);
  return { x, y, z, ...q, yaw, pitch };
}

/**
 * Convert normalized screen coordinates (0-1) to yaw/pitch angles.
 * Screen center (0.5, 0.5) maps to the current camera orientation.
 */
export function screenToYawPitch(
  x: number,
  y: number,
  currentYaw: number,
  currentPitch: number,
  width: number,
  height: number,
): { yaw: number; pitch: number } {
  const hFov = Math.PI / 2; // 90 degrees
  const vFov = hFov * (height / width);
  return {
    yaw: currentYaw - (x - 0.5) * hFov,
    pitch: currentPitch - (y - 0.5) * vFov,
  };
}
