/** Type definitions for Cast 2.0 protocol structures. */

export interface XrspHeader {
  flags: number;
  topic: number;
  wordCount: number;
  seq: number;
  padding: number;
}

export interface MgikSubHeader {
  subMagic: number;
  msgSeq: number;
  ackSeq: number;
}

export interface LayerInfo {
  id: number;
  width: number;
  height: number;
  posX: number;
  posY: number;
  depth: number;
  type: number;
  typeName: string;
  app: string;
  layer: string;
  serial: string;
  pkg: string;
}

/**
 * Camera pose as an offset from the headset's position when casting started.
 * Coordinates are relative to the headset, not absolute world space.
 */
export interface PoseState {
  x: number;
  y: number;
  z: number;
  qw: number;
  qx: number;
  qy: number;
  qz: number;
  yaw: number;
  pitch: number;
}

/** Incremental movement relative to the current camera offset. */
export interface PoseDelta {
  dForward?: number;
  dStrafe?: number;
  dUp?: number;
  dYaw?: number;
  dPitch?: number;
}

/** Set camera offset directly (relative to headset, not world space). */
export interface PoseOffset {
  x?: number;
  y?: number;
  z?: number;
  yaw?: number;
  pitch?: number;
}
