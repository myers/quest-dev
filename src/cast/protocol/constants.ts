/** XRSP / MGIK / MUD protocol constants for Cast 2.0. */

// XRSP header
export const XRSP_FLAGS_STANDARD = 0x10;
export const XRSP_FLAGS_ALIGNMENT_PAD = 0x18;
export const XRSP_TOPIC_CAST = 2;
export const XRSP_HEADER_SIZE = 8;

// Markers
export const VIDEO_META_MARKER = 0x64;
export const ACK_MARKER = 0x03;
export const CONFIG_MARKER = 0x12c; // LayerConfiguration (300)
export const MGIK_MAGIC = 0x4d47494b; // "MGIK" as big-endian u32

// MGIK sub-header tail signature: (0, 1, 2)
export const MGIK_TAIL_SIGNATURE = [0, 1, 2] as const;
export const MGIK_SUB_HEADER_SIZE = 24;

// MUD command IDs
export const CMD_KEEPALIVE = 0x04;
export const CMD_CONFIG = 0x07;
export const CMD_DISCONNECT = 0x08;
export const CMD_DISPLAY_CONFIG = 0x09;
export const CMD_SET_PROPERTY = 10; // 0x0a
export const CMD_SHORT_ACK_65 = 0x65;
export const CMD_VIDEO_META = 0x64;
export const CMD_POSE = 0xce;
export const CMD_SHORT_ACK_CD = 0xcd;
export const CMD_VIRTUAL_MOUSE = 200; // 0xc8
export const CMD_INPUT_FORWARDING_STATE = 205; // 0xcd
export const CMD_START_INPUT_FORWARDING = 207; // 0xcf
export const CMD_INIT = 0x258;
export const CMD_LAYER_CONFIGURATION = 0x12c; // 300
export const CMD_SHORT_ACK_12D = 0x12d;
export const CMD_ACTIVATE_LAYER = 301; // 0x12d

// VirtualMouse actions
export const MOUSE_MOVE = 1;
export const MOUSE_DOWN = 3;
export const MOUSE_UP = 4;

// Input forwarding states
export const INPUT_STATE_NORMAL = 0;
export const INPUT_STATE_CAMERA = 1;

// Layer types
export const LAYER_PANEL_APP = 0;
export const LAYER_EYE_BUFFER = 1;
export const LAYER_AETHER_APP = 2;
export const LAYER_VOLUMETRIC_WINDOW = 3;

export const LAYER_TYPE_NAMES: Record<number, string> = {
  [LAYER_PANEL_APP]: "PANEL_APP",
  [LAYER_EYE_BUFFER]: "EYE_BUFFER",
  [LAYER_AETHER_APP]: "AETHER_APP",
  [LAYER_VOLUMETRIC_WINDOW]: "VOLUMETRIC_WINDOW",
};

// Cast TCP ports — MQDH uses 4446 for debug.oculus.magic.port, maps both 4445 and 4446
export const CAST_PORT = 4445;
export const QUEST_CAST_PORT = 4446;

// Keepalive ack value progression
export const KEEPALIVE_INITIAL_ACK = 0xc8;
export const KEEPALIVE_ACK_INCREMENT = 0xc8;
