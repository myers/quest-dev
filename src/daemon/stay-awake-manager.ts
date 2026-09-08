/**
 * Stay-awake manager for the daemon process.
 * Manages Quest protections lifecycle (turning them off so the headset stays
 * awake, and restoring them on cleanup).
 */

import {
  setQuestProtections,
  getQuestProtections,
  restoreProtectionsSync,
  formatQuestProtections,
  type QuestProtections,
} from "../utils/quest-protections.js";
import { execCommand } from "../utils/exec.js";
import { adbArgs } from "../utils/adb.js";

/** Apply protections, returning the provider's rejection message instead of throwing. */
async function trySetQuestProtections(pin: string, protectionsOn: boolean): Promise<string | null> {
  try {
    await setQuestProtections(pin, protectionsOn);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

export class StayAwakeManager {
  private active = false;
  private pin: string | undefined;

  /** Whether stay-awake is currently on */
  get isEnabled(): boolean {
    return this.active;
  }

  /**
   * Turn stay-awake on (turn Quest protections off).
   *
   * Always talks to the device and always reads GET_PROPERTY back. The
   * in-memory `active` flag is a cache of device state and goes stale
   * whenever anything else touches com.oculus.rc (another tool, a reboot,
   * the VR shell); trusting it is how `deploy` came to print
   * "Stay-awake: already enabled" over a headset with three of the four
   * properties off. Throws if the properties did not take.
   */
  async turnOn(pin: string): Promise<void> {
    this.pin = pin;
    // GET_PROPERTY is the authority, so a SET_PROPERTY rejection is only fatal
    // when the readback disagrees — re-applying to a headset already in test
    // mode stays idempotent (deploy leans on that) even if the provider
    // refused the call.
    const setError = await trySetQuestProtections(pin, false);
    const props = await getQuestProtections();
    const stillOn = (Object.keys(props) as (keyof QuestProtections)[]).filter((k) => props[k]);
    if (stillOn.length > 0) {
      this.active = false;
      throw new Error(
        setError
          ? `${setError}. Protections still on: ${stillOn.join(", ")}.`
          : `SET_PROPERTY reported success but GET_PROPERTY still reads these protections on: ` +
            `${stillOn.join(", ")}. Wrong PIN, or the com.oculus.rc provider rejected the call.`,
      );
    }
    this.active = true;
    // Wake screen
    try {
      await execCommand("adb", adbArgs("shell", "input", "keyevent", "KEYCODE_WAKEUP"));
    } catch {
      // Non-fatal
    }
    console.log("Stay-awake on — guardian, dialogs, autosleep, proximity off");
  }

  /**
   * Turn stay-awake off (restore Quest protections).
   *
   * The mirror of turnOn(): always talks to the device and always reads
   * GET_PROPERTY back. It used to early-return on its own `active` flag and
   * ignore SET_PROPERTY's result, so `stay-awake --off` printed success over a
   * headset that still had autosleep disabled — the battery-drain case cleanup
   * exists to prevent. Throws if the protections did not come back on.
   *
   * @param pin - PIN to use when the manager has none cached (a daemon that
   *              restarted while the device was left in test mode).
   */
  async turnOff(pin?: string): Promise<void> {
    const usePin = pin ?? this.pin;
    if (!usePin) {
      throw new Error(
        "No PIN known, cannot restore Quest protections. Pass --pin or save one " +
        "with `quest-dev config --pin`.",
      );
    }
    const setError = await trySetQuestProtections(usePin, true);
    const props = await getQuestProtections();
    const stillOff = (Object.keys(props) as (keyof QuestProtections)[]).filter((k) => !props[k]);
    if (stillOff.length > 0) {
      throw new Error(
        (setError ?? "SET_PROPERTY reported success but GET_PROPERTY disagrees") +
        `. These protections are still off: ${stillOff.join(", ")}. The headset is ` +
        `still in test mode and will not sleep.`,
      );
    }
    this.pin = usePin;
    this.active = false;
    console.log("Stay-awake off — guardian, dialogs, autosleep, proximity on");
  }

  /**
   * Synchronous cleanup for signal handlers. Cannot verify (no await), but
   * says so out loud when the provider rejects the call instead of exiting
   * quietly as if the headset had been handed back.
   */
  cleanupSync(): void {
    if (!this.pin) return;
    const error = restoreProtectionsSync(this.pin);
    if (error) {
      console.error(
        `Failed to restore Quest protections: ${error}. The headset is still in ` +
        `test mode — run \`quest-dev stay-awake --off\` once the cause is fixed.`,
      );
      return;
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
