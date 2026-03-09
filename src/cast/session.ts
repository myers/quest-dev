/**
 * CastSession: manages TCP connections to Quest, protocol handshake,
 * H.264 video decoding, pose control, and stay-awake lifecycle.
 */

import { createServer, type Server, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { FrameDecoder } from "./decoder.js";
import { createPoseState, eulerToQuat, updatePose, setPoseAbsolute } from "./pose.js";
import {
  type LayerInfo,
  type PoseAbsolute,
  type PoseDelta,
  type PoseState,
  type XrspHeader,
  parseXrspHeader,
  xrspPayloadSize,
  packXrsp,
  XRSP_HEADER_SIZE,
  ACK_MARKER,
  CONFIG_MARKER,
  VIDEO_META_MARKER,
  MGIK_MAGIC,
  CAST_PORT,
  CMD_SHORT_ACK_65,
  CMD_SHORT_ACK_CD,
  CMD_SHORT_ACK_12D,
  KEEPALIVE_ACK_INCREMENT,
  LAYER_PANEL_APP,
} from "./protocol/index.js";
import {
  packMgikSub,
  detectSubMagic,
  isMgikMagic,
} from "./protocol/mgik.js";
import {
  buildInit,
  buildConfig,
  buildKeepalive,
  buildShortAck,
  buildPose,
  buildDisplayConfig,
  buildDisconnect,
  buildSetProperty,
  buildVirtualMouse,
  buildInputForwardingState,
  buildStartInputForwarding,
  buildActivateLayer,
  buildMud,
  parseLayerConfiguration,
} from "./protocol/mud.js";
import { execCommand } from "../utils/exec.js";
import { verbose } from "../utils/verbose.js";

export interface CastSessionOptions {
  listenPort?: number;
  width?: number;
  height?: number;
}

export class CastSession extends EventEmitter {
  // Configuration
  private _listenPort: number;

  // Connection state
  private _connected = false;
  private _running = false;
  private server: Server | null = null;
  private controlSocket: Socket | null = null;
  private videoSocket: Socket | null = null;
  private controlSeq = 0;

  // Protocol state
  private subMagic: number | null = null;
  private controlMsgSeq = 0;
  private sessionUuid: string;
  private sessionTimestamp: string;
  private questMsgSeq = 0;

  // Video state
  private decoder: FrameDecoder;
  private currentSpsPps: Buffer | null = null;
  private currentIdr: Buffer | null = null;
  private _frameCount = 0;
  private _byteCount = 0;
  private startTime = 0;

  // Display
  private _width: number;
  private _height: number;

  // Pose
  private _pose: PoseState;
  private _poseLoopTimer: ReturnType<typeof setInterval> | null = null;
  private _poseLoopActive = false;

  // Input forwarding
  private inputForwardingStarted = false;
  private _layerId = 0;
  private _layers = new Map<number, LayerInfo>();

  constructor(options: CastSessionOptions = {}) {
    super();
    this._listenPort = options.listenPort ?? CAST_PORT;
    this._width = options.width ?? 2064;
    this._height = options.height ?? 1162;
    this.sessionUuid = randomUUID();
    this.sessionTimestamp = String(Date.now());
    this._pose = createPoseState();
    this.decoder = new FrameDecoder();

    this.decoder.on("frame", () => {
      this.emit("frame");
    });
  }

  // --- Public getters ---

  get listenPort(): number { return this._listenPort; }
  get connected(): boolean { return this._connected; }
  get running(): boolean { return this._running; }
  get frameCount(): number { return this._frameCount; }
  get byteCount(): number { return this._byteCount; }
  get width(): number { return this._width; }
  get height(): number { return this._height; }
  get pose(): PoseState { return this._pose; }
  get layers(): Map<number, LayerInfo> { return this._layers; }
  get layerId(): number { return this._layerId; }

  get poseLoopActive(): boolean { return this._poseLoopActive; }

  get fps(): number {
    const elapsed = this.startTime > 0 ? (Date.now() - this.startTime) / 1000 : 0;
    return elapsed > 0 ? Math.round((this._frameCount / elapsed) * 10) / 10 : 0;
  }

  // --- Lifecycle ---

  /** Bind the TCP server, trying successive ports on EADDRINUSE. */
  async bind(): Promise<void> {
    FrameDecoder.checkFfmpeg();

    const maxAttempts = 10;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await this.tryBind(this._listenPort);
        verbose(`TCP server listening on port ${this._listenPort}`);
        return;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
          verbose(`Port ${this._listenPort} in use, trying ${this._listenPort + 1}`);
          this._listenPort++;
        } else {
          throw err;
        }
      }
    }
    throw new Error(`No available port found (tried ${maxAttempts} ports)`);
  }

  private tryBind(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer();
      this.server.listen(port, "0.0.0.0", () => resolve());
      this.server.on("error", reject);
    });
  }

  async start(questIp?: string): Promise<void> {
    this._running = true;
    this.startTime = Date.now();

    await this.waitForConnections(questIp);
  }

  async stop(): Promise<void> {
    this._running = false;

    if (this._connected && this.subMagic) {
      try {
        this.sendXrsp(buildDisconnect(this.subMagic, this.nextSeq()));
      } catch {
        // Best effort
      }
    }

    this.stopPoseLoop();
    this.decoder.stop();
    this.controlSocket?.destroy();
    this.videoSocket?.destroy();
    this.server?.close();
    this._connected = false;
    this.emit("disconnected");
  }

  async restart(): Promise<void> {
    verbose("Restarting cast session...");
    await this.stop();

    // Reset protocol state
    this.sessionUuid = randomUUID();
    this.sessionTimestamp = String(Date.now());
    this.subMagic = null;
    this.controlMsgSeq = 0;
    this.controlSeq = 0;
    this._frameCount = 0;
    this._byteCount = 0;
    this.currentSpsPps = null;
    this.currentIdr = null;
    this._pose = createPoseState();
    this.inputForwardingStarted = false;
    this._layers.clear();

    await new Promise((r) => setTimeout(r, 1000));
    await this.start();
  }

  // --- ADB Setup ---

  async adbSetup(questIp: string): Promise<void> {
    verbose("Setting up ADB for Quest at", questIp);
    const device = `${questIp}:5555`;

    await execCommand("adb", ["connect", device]);
    await execCommand("adb", [
      "-s", device, "shell",
      "setprop debug.oculus.command_line_media_capture Casting",
    ]);
    // Tell Quest which port to connect to
    await execCommand("adb", [
      "-s", device, "shell",
      `setprop debug.oculus.magic.port ${this.listenPort}`,
    ]);
    verbose("Setting up ADB reverse port forward...");
    await execCommand("adb", [
      "-s", device, "reverse",
      `tcp:${this.listenPort}`, `tcp:${this.listenPort}`,
    ]);
  }

  async startCastService(questIp: string): Promise<void> {
    const device = `${questIp}:5555`;
    verbose("Starting cast service on Quest...");
    await execCommand("adb", [
      "-s", device, "shell",
      "am start-foreground-service -n com.oculus.magicislandcastingservice/.CastingService",
    ]);
    await new Promise((r) => setTimeout(r, 1000));
    await execCommand("adb", [
      "-s", device, "shell",
      "am broadcast -a com.oculus.magicislandcastingservice.CONNECT",
    ]);
  }

  // --- TCP ---

  private waitForConnections(questIp?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        reject(new Error("TCP server not bound — call bind() first"));
        return;
      }

      const connections: Socket[] = [];
      let resolved = false;

      this.server.on("connection", (socket: Socket) => {
        const idx = connections.length + 1;
        verbose(`Connection #${idx} from ${socket.remoteAddress}`);
        connections.push(socket);

        if (connections.length >= 2) {
          this.controlSocket = connections[0];
          this.videoSocket = connections[1];
          this._connected = true;
          verbose("Both connections established");
          this.emit("connected");
          this.handleVideo();
          if (!resolved) {
            resolved = true;
            resolve();
          }
        }
      });

      // Trigger the cast service now that we're listening
      if (questIp) {
        this.startCastService(questIp).catch((err) => {
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        });
      }

      // Timeout after 15 seconds
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          if (connections.length < 2) {
            verbose(`Timed out waiting for Quest connections (got ${connections.length})`);
            this.server?.close();
            reject(new Error(`Timed out waiting for Quest connections (got ${connections.length}/2)`));
          }
        }
      }, 15000);

      this.server.on("error", (err) => {
        clearTimeout(timeout);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      // Clear timeout once we get both connections
      this.once("connected", () => clearTimeout(timeout));
    });
  }

  // --- XRSP I/O ---

  private sendXrsp(payload: Buffer, flags?: number): void {
    if (!this.controlSocket || this.controlSocket.destroyed) return;
    const pkt = packXrsp(this.controlSeq, payload, flags);
    this.controlSeq++;
    this.controlSocket.write(pkt);
  }

  private nextSeq(): number {
    return this.controlMsgSeq++;
  }

  // --- Video handling (main protocol loop) ---

  private handleVideo(): void {
    if (!this.videoSocket) return;

    let buffer = Buffer.alloc(0);
    let handshakeStage = 0;
    let ackVal = 0;

    this.videoSocket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= XRSP_HEADER_SIZE) {
        const header = parseXrspHeader(buffer);
        const payloadSize = xrspPayloadSize(header);
        const totalSize = XRSP_HEADER_SIZE + payloadSize;

        if (buffer.length < totalSize) break; // Need more data

        const payload = buffer.subarray(XRSP_HEADER_SIZE, totalSize);
        buffer = buffer.subarray(totalSize);

        this.processVideoPayload(payload, header, handshakeStage, ackVal, (newStage, newAck) => {
          handshakeStage = newStage;
          ackVal = newAck;
        });
      }
    });

    this.videoSocket.on("end", () => {
      verbose("Video connection EOF");
      this._running = false;
      this.emit("disconnected");
    });

    this.videoSocket.on("error", (err) => {
      verbose("Video connection error:", err.message);
      this._running = false;
      this.emit("error", err);
    });
  }

  private processVideoPayload(
    payload: Buffer,
    _header: XrspHeader,
    handshakeStage: number,
    ackVal: number,
    setState: (stage: number, ack: number) => void,
  ): void {
    if (payload.length < 4) return;

    const first4 = payload.readUInt32BE(0);

    // Skip MGIK magic header
    if (isMgikMagic(payload)) return;

    // Learn sub-magic from first Quest message
    if (this.subMagic === null && payload.length === 24) {
      const detected = detectSubMagic(payload);
      if (detected !== null) {
        this.subMagic = detected;
        this.questMsgSeq = payload.readUInt32BE(4);
        verbose(`Learned sub-magic: 0x${this.subMagic.toString(16).padStart(8, "0")}`);
        return;
      }
    }

    // Sub-magic echo (update quest msg seq)
    if (this.subMagic && first4 === this.subMagic) {
      this.questMsgSeq = payload.readUInt32BE(4);
      return;
    }

    // Transport string
    if (first4 === 0x00000001 && payload.length >= 12) {
      const strLen = payload.readUInt32BE(8);
      if (12 + strLen <= payload.length && strLen > 4) {
        const candidate = payload.subarray(12, 12 + strLen);
        if (candidate.every((b) => b >= 32 && b < 127)) {
          verbose("Quest transport:", candidate.toString("ascii"));
          if (this.subMagic && handshakeStage === 0) {
            this.sendXrsp(buildInit(this.subMagic, this.nextSeq()));
            setState(1, ackVal);
          }
          return;
        }
      }

      // H.264 NAL unit
      const nalType = payload[4] & 0x1f;
      if (nalType === 7 || nalType === 5 || nalType === 1 || nalType === 6 || nalType === 8 ||
          (nalType > 0 && payload.length > 50)) {
        if (nalType === 7) {
          this.currentSpsPps = Buffer.from(payload);
          verbose(`SPS+PPS (${payload.length} bytes)`);
          if (!this.decoder.isRunning) {
            this.decoder.start();
          }
        } else if (nalType === 5) {
          this.currentIdr = Buffer.from(payload);
          verbose(`IDR keyframe (${payload.length} bytes)`);
        }
        this._frameCount++;
        this._byteCount += payload.length;
        this.decoder.feed(payload);
      }
      return;
    }

    // Quest ACK
    if (first4 === ACK_MARKER && payload.length === 8) {
      const val = payload.readUInt32BE(4);
      verbose(`Quest ACK: ${val} (stage=${handshakeStage})`);

      if (this.subMagic) {
        if (handshakeStage === 1) {
          this.sendXrsp(
            buildConfig(this.subMagic, this.nextSeq(),
              this._width, this._height,
              this.sessionUuid, this.sessionTimestamp),
          );
          setState(2, ackVal);
        } else if (handshakeStage === 3) {
          this.sendXrsp(buildShortAck(this.subMagic, this.nextSeq(), CMD_SHORT_ACK_65));
          ackVal = 0x195;
          this.sendXrsp(
            buildKeepalive(this.subMagic, this.questMsgSeq, ackVal,
              this.sessionUuid, this.sessionTimestamp),
          );
          setState(4, ackVal);
        } else if (handshakeStage === 4) {
          ackVal = 0x25d;
          this.sendXrsp(
            buildKeepalive(this.subMagic, this.questMsgSeq, ackVal,
              this.sessionUuid, this.sessionTimestamp),
          );
          setState(5, ackVal);
        } else if (handshakeStage >= 5) {
          ackVal += KEEPALIVE_ACK_INCREMENT;
          this.sendXrsp(
            buildKeepalive(this.subMagic, this.questMsgSeq, ackVal,
              this.sessionUuid, this.sessionTimestamp),
          );
          setState(handshakeStage, ackVal);
        }
      }
      return;
    }

    // LayerConfiguration (type 300 = 0x12C)
    if (first4 === CONFIG_MARKER) {
      const layer = parseLayerConfiguration(payload);
      if (layer) {
        verbose(`LayerConfig: id=${layer.id} ${layer.width}x${layer.height} type=${layer.typeName} app=${layer.app}`);
        this._layers.set(layer.id, layer);
        this._width = layer.width;
        this._height = layer.height;
        if (layer.type === LAYER_PANEL_APP && this._layerId === 0) {
          this._layerId = layer.id;
          verbose(`Auto-selected PANEL_APP layer ${layer.id} for input`);
        }
        this.emit("layer", layer);
      } else if (payload.length >= 16) {
        this._width = payload.readUInt32BE(8);
        this._height = payload.readUInt32BE(12);
        verbose(`Quest config: ${this._width}x${this._height} (short payload)`);
      }

      if (this.subMagic && handshakeStage === 2) {
        ackVal = KEEPALIVE_ACK_INCREMENT; // 0xC8
        this.sendXrsp(
          buildKeepalive(this.subMagic, this.questMsgSeq, ackVal,
            this.sessionUuid, this.sessionTimestamp),
        );
        for (let i = 0; i < 3; i++) {
          this.sendXrsp(buildShortAck(this.subMagic, this.nextSeq(), CMD_SHORT_ACK_CD));
        }
        this.sendXrsp(buildShortAck(this.subMagic, this.nextSeq(), CMD_SHORT_ACK_12D));
        setState(3, ackVal);
      }
      return;
    }

    // VideoMeta
    if (first4 === VIDEO_META_MARKER && payload.length === 16) {
      if (this._frameCount > 0 && this._frameCount % 6 === 0 && this.subMagic) {
        ackVal += KEEPALIVE_ACK_INCREMENT;
        this.sendXrsp(
          buildKeepalive(this.subMagic, this.questMsgSeq, ackVal,
            this.sessionUuid, this.sessionTimestamp),
        );
        setState(handshakeStage, ackVal);
      }
    }
  }

  // --- Public control methods ---

  getScreenshot(): Buffer | null {
    return this.decoder.getFrame();
  }

  sendPose(pose: PoseState): void {
    this._pose = pose;
    if (this._connected && this.subMagic) {
      this.sendXrsp(buildPose(this.subMagic, this.nextSeq(), this._pose));
    }
    // Auto-start periodic pose loop on first pose send
    if (!this._poseLoopActive) {
      this.startPoseLoop();
    }
  }

  applyPoseDelta(delta: PoseDelta): void {
    this._pose = updatePose(this._pose, delta);
    this.sendPose(this._pose);
  }

  setPoseAbsolute(abs: PoseAbsolute): void {
    this._pose = setPoseAbsolute(this._pose, abs);
    this.sendPose(this._pose);
  }

  /** Start periodic pose refresh at ~27 Hz (matching MQDH cadence). */
  startPoseLoop(): void {
    if (this._poseLoopActive) return;
    this._poseLoopActive = true;
    verbose("Pose loop started (~27 Hz)");
    this._poseLoopTimer = setInterval(() => {
      if (this._connected && this.subMagic) {
        this.sendXrsp(buildPose(this.subMagic, this.nextSeq(), this._pose));
      }
    }, 37);
    this.emit("pose-loop", true);
  }

  /** Stop periodic pose refresh. */
  stopPoseLoop(): void {
    if (!this._poseLoopActive) return;
    this._poseLoopActive = false;
    if (this._poseLoopTimer) {
      clearInterval(this._poseLoopTimer);
      this._poseLoopTimer = null;
    }
    verbose("Pose loop stopped");
    this.emit("pose-loop", false);
  }

  sendDisplayConfig(width: number, height: number, eye?: number): void {
    if (this._connected && this.subMagic) {
      // Reset first, then config (matching Python behavior)
      this.sendXrsp(buildInit(this.subMagic, this.nextSeq()));
      this.sendXrsp(buildDisplayConfig(this.subMagic, this.nextSeq(), width, height, eye));
      this._width = width;
      this._height = height;
    }
  }

  async sendClick(x = 0.5, y = 0.5, layerId?: number, holdMs = 50): Promise<void> {
    if (!this._connected || !this.subMagic) return;

    // Auto-select layer
    const lid = layerId ?? this.autoSelectLayer();

    // MOVE events to position virtual cursor
    for (let i = 0; i < 3; i++) {
      this.sendXrsp(buildVirtualMouse(this.subMagic, this.nextSeq(), lid, 1, x, y));
      await new Promise((r) => setTimeout(r, 16));
    }

    // DOWN
    this.sendXrsp(buildVirtualMouse(this.subMagic, this.nextSeq(), lid, 3, x, y));
    await new Promise((r) => setTimeout(r, holdMs));

    // UP
    this.sendXrsp(buildVirtualMouse(this.subMagic, this.nextSeq(), lid, 4, x, y));
  }

  ensureInputForwarding(): void {
    if (this.inputForwardingStarted) return;
    if (!this._connected || !this.subMagic) return;

    this.sendXrsp(buildSetProperty(this.subMagic, this.nextSeq(),
      "input_forwarding_gaze_click", "true"));
    this.sendXrsp(buildInputForwardingState(this.subMagic, this.nextSeq(), 1));
    this.sendXrsp(buildStartInputForwarding(this.subMagic, this.nextSeq()));
    this.sendXrsp(buildActivateLayer(this.subMagic, this.nextSeq(), this._layerId));
    this.inputForwardingStarted = true;
    verbose("Input forwarding enabled (CAMERA mode, gaze_click=true)");
  }

  sendInputForwardingState(state: number): void {
    if (this._connected && this.subMagic) {
      this.sendXrsp(buildInputForwardingState(this.subMagic, this.nextSeq(), state));
      if (state === 0) {
        this.inputForwardingStarted = false;
      }
    }
  }

  resetView(): void {
    this.sendInputForwardingState(0);
    this._pose = createPoseState();
  }

  sendSetProperty(name: string, value: string): void {
    if (this._connected && this.subMagic) {
      this.sendXrsp(buildSetProperty(this.subMagic, this.nextSeq(), name, value));
    }
  }

  sendMud(typeId: number, payload?: Buffer): void {
    if (this._connected && this.subMagic) {
      this.sendXrsp(buildMud(this.subMagic, this.nextSeq(), typeId, payload));
    }
  }

  sendRotation(pitch = 0, yaw = 0, forward = 0, strafe = 0): void {
    this.applyPoseDelta({ dYaw: yaw, dPitch: pitch, dForward: forward, dStrafe: strafe });
  }

  // --- Helpers ---

  private autoSelectLayer(): number {
    let bestId = this._layerId;
    let bestArea = 0;
    for (const [id, info] of this._layers) {
      if (info.type === 0 || info.type === 3) { // PANEL_APP or VOLUMETRIC_WINDOW
        const area = info.width * info.height;
        if (area > bestArea) {
          bestId = id;
          bestArea = area;
        }
      }
    }
    return bestId;
  }
}
