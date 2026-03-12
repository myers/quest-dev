/**
 * Stay-awake manager for the daemon process.
 * Extracted from stay-awake.ts — manages test properties lifecycle.
 */

import { execSync } from "node:child_process";
import {
  buildSetPropertyArgs,
  setTestProperties,
  getTestProperties,
  formatTestProperties,
  type TestProperties,
} from "../utils/test-properties.js";
import { execCommand } from "../utils/exec.js";
import { verbose } from "../utils/verbose.js";

export class StayAwakeManager {
  private enabled = false;
  private pin: string | undefined;

  /** Whether stay-awake is currently enabled */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Enable test properties (guardian, dialogs, autosleep, proximity) */
  async enable(pin: string): Promise<void> {
    if (this.enabled) {
      verbose("stay-awake already enabled");
      return;
    }
    this.pin = pin;
    await setTestProperties(pin, true);
    this.enabled = true;
    // Wake screen
    try {
      await execCommand("adb", ["shell", "input", "keyevent", "KEYCODE_WAKEUP"]);
    } catch {
      // Non-fatal
    }
    console.log("Stay-awake enabled (guardian, dialogs, autosleep disabled)");
  }

  /** Disable test properties (restore Quest to normal) */
  async disable(): Promise<void> {
    if (!this.enabled || !this.pin) {
      verbose("stay-awake not enabled, nothing to disable");
      return;
    }
    try {
      await setTestProperties(this.pin, false);
      console.log("Stay-awake disabled (guardian, dialogs, autosleep restored)");
    } catch (error) {
      console.error("Failed to disable stay-awake:", (error as Error).message);
    }
    this.enabled = false;
  }

  /** Synchronous cleanup for signal handlers */
  cleanupSync(): void {
    if (!this.enabled || !this.pin) return;
    try {
      const args = buildSetPropertyArgs(this.pin, false);
      execSync(`adb ${args.join(" ")}`, { stdio: "ignore" });
    } catch {
      // Best-effort
    }
    this.enabled = false;
  }

  /** Get current test property status */
  async status(): Promise<TestProperties> {
    return getTestProperties();
  }

  /** Format status for display */
  formatStatus(props: TestProperties): string {
    return formatTestProperties(props);
  }
}
