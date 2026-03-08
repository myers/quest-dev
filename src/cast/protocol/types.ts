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

export interface PoseDelta {
  dForward?: number;
  dStrafe?: number;
  dUp?: number;
  dYaw?: number;
  dPitch?: number;
}

export interface PoseAbsolute {
  x?: number;
  y?: number;
  z?: number;
  yaw?: number;
  pitch?: number;
}
