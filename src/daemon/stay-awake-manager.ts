/**
 * Stay-awake manager for the daemon process.
 * Manages Quest protections lifecycle (turning them off so the headset stays
 * awake, and restoring them on cleanup).
 */

import { execFileSync } from "node:child_process";
import {
  buildSetPropertyArgs,
  setQuestProtections,
  getQuestProtections,
  formatQuestProtections,
  type QuestProtections,
} from "../utils/quest-protections.js";
import { execCommand } from "../utils/exec.js";
import { verbose } from "../utils/verbose.js";
import { adbArgs, getAdbDevice } from "../utils/adb.js";

export class StayAwakeManager {
  private active = false;
  private pin: string | undefined;

  /** Whether stay-awake is currently on */
  get isEnabled(): boolean {
    return this.active;
  }

  /** Turn stay-awake on (turn Quest protections off) */
  async turnOn(pin: string): Promise<void> {
    if (this.active) {
      verbose("stay-awake already on");
      return;
    }
    this.pin = pin;
    await setQuestProtections(pin, false);
    this.active = true;
    // Wake screen
    try {
      await execCommand("adb", adbArgs("shell", "input", "keyevent", "KEYCODE_WAKEUP"));
    } catch {
      // Non-fatal
    }
    console.log("Stay-awake on — guardian, dialogs, autosleep off");
  }

  /** Turn stay-awake off (restore Quest protections) */
  async turnOff(): Promise<void> {
    if (!this.active || !this.pin) {
      verbose("stay-awake already off");
      return;
    }
    try {
      await setQuestProtections(this.pin, true);
      console.log("Stay-awake off — guardian, dialogs, autosleep on");
    } catch (error) {
      console.error("Failed to turn stay-awake off:", (error as Error).message);
    }
    this.active = false;
  }

  /** Synchronous cleanup for signal handlers */
  cleanupSync(): void {
    if (!this.active || !this.pin) return;
    try {
      const args = buildSetPropertyArgs(this.pin, true);
      const device = getAdbDevice();
      const adb = device ? ["-s", device, ...args] : args;
      execFileSync("adb", adb, { stdio: "ignore" });
    } catch {
      // Best-effort
    }
    this.active = false;
  }

  /** Get current protection status */
  async status(): Promise<QuestProtections> {
    return getQuestProtections();
  }

  /** Format status for display */
  formatStatus(props: QuestProtections): string {
    return formatQuestProtections(props);
  }
}
