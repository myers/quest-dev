/**
 * Quest protection state.
 *
 * Wraps Meta's "Scriptable Testing Services" API (content://com.oculus.rc).
 * Meta's docs: https://developers.meta.com/horizon/documentation/unity/ts-scriptable-testing/
 *
 * We use it to turn Quest protections (guardian, system dialogs, autosleep)
 * on or off so the headset can be driven from automation without falling
 * asleep.
 *
 * Shared between stay-awake and cast commands. Internal model is positive-form:
 * `true` means the protection is on (Quest in its normal state). Meta's wire
 * format is negative-form (`disable_*`); we translate at the parser and
 * builder boundaries.
 */

import { execFileSync } from "node:child_process";
import { execCommandFull } from "./exec.js";
import { adbArgs } from "./adb.js";

export interface QuestProtections {
  guardian: boolean;       // true = guardian boundary active (normal)
  dialogs: boolean;        // true = system dialogs shown (normal)
  autosleep: boolean;      // true = headset will sleep when idle (normal)
  proximityClose: boolean; // true = real proximity sensor in use (normal:
                           // headset sleeps when off-head). Wire field
                           // `set_proximity_close=true` means "force-treat
                           // sensor as closed" = override = our `false`.

}

/**
 * Build ADB args for SET_PROPERTY call.
 * `protectionsOn=true` restores normal Quest behavior; `false` turns
 * protections off so the headset stays awake for testing.
 */
export function buildSetPropertyArgs(pin: string, protectionsOn: boolean): string[] {
  const disable = !protectionsOn;
  return [
    "shell", "content", "call",
    "--uri", "content://com.oculus.rc",
    "--method", "SET_PROPERTY",
    "--extra", `disable_guardian:b:${disable}`,
    "--extra", `disable_dialogs:b:${disable}`,
    "--extra", `disable_autosleep:b:${disable}`,
    "--extra", `set_proximity_close:b:${disable}`,
    "--extra", `PIN:s:${pin}`,
  ];
}

/**
 * Parse GET_PROPERTY Bundle output into structured data.
 * Input wire format: "Bundle[{disable_guardian=true, set_proximity_close=true, ...}]"
 * Output is positive-form: a `disable_*=true` field maps to a positive flag of `false`.
 * Absent fields default to `true` (protection on / normal).
 */
export function parseQuestProtections(output: string): QuestProtections {
  const result: QuestProtections = {
    guardian: true,
    dialogs: true,
    autosleep: true,
    proximityClose: true,
  };

  const match = output.match(/Bundle\[\{(.+)\}\]/);
  if (!match) return result;

  const pairs = match[1].split(",").map((s) => s.trim());
  for (const pair of pairs) {
    const [key, value] = pair.split("=");
    if (!key || !value) continue;
    const isTrue = value === "true";
    switch (key) {
      case "disable_guardian":     result.guardian = !isTrue; break;
      case "disable_dialogs":      result.dialogs = !isTrue; break;
      case "disable_autosleep":    result.autosleep = !isTrue; break;
      case "set_proximity_close":  result.proximityClose = !isTrue; break;
    }
  }

  return result;
}

/**
 * Pull the failure out of a SET_PROPERTY Result bundle.
 *
 * `adb shell content call` exits 0 whatever the provider decides, so the exit
 * status reports success for a call that changed nothing. The provider's own
 * answer is the only honest signal:
 *
 *   Bundle[{Message=PIN verification failed: ... 400 - NON_NETWORK_ISSUE, Success=false}]
 *
 * Returns the message when the bundle says `Success=false`, else null. Anything
 * we don't recognise (empty output, an OS that answers differently) is treated
 * as "not visibly a failure" — callers verify with GET_PROPERTY anyway, and a
 * parser that invents failures is worse than one that misses them.
 */
export function parseSetPropertyError(output: string): string | null {
  if (!/Success\s*=\s*false/.test(output)) return null;
  const message = output.match(/Message=([\s\S]*?)(?:,\s*Success=|\}\])/);
  return message?.[1].trim() || "SET_PROPERTY returned Success=false";
}

/**
 * Call SET_PROPERTY. `protectionsOn=true` restores Quest to normal.
 * Throws when the provider rejected the call (bad PIN, PIN verification
 * failure) — the exit code alone will not tell you.
 */
export async function setQuestProtections(
  pin: string,
  protectionsOn: boolean,
): Promise<void> {
  const args = adbArgs(...buildSetPropertyArgs(pin, protectionsOn));
  const { stdout, stderr, code } = await execCommandFull("adb", args);
  if (code !== 0) {
    throw new Error(`SET_PROPERTY failed: adb exited ${code}: ${stderr.trim()}`);
  }
  const error = parseSetPropertyError(stdout);
  if (error) throw new Error(`SET_PROPERTY rejected: ${error}`);
}

/**
 * Restore protections synchronously, for signal handlers and watchdogs that
 * cannot await. Returns an error message, or null on an accepted call.
 * Never throws.
 */
export function restoreProtectionsSync(pin: string): string | null {
  try {
    const out = execFileSync("adb", adbArgs(...buildSetPropertyArgs(pin, true)), {
      encoding: "utf-8",
    });
    return parseSetPropertyError(out);
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * Call GET_PROPERTY and return parsed protections.
 */
export async function getQuestProtections(): Promise<QuestProtections> {
  const result = await execCommandFull("adb", adbArgs(
    "shell", "content", "call",
    "--uri", "content://com.oculus.rc",
    "--method", "GET_PROPERTY",
  ));
  return parseQuestProtections(result.stdout);
}

/**
 * Format protections for display.
 */
export function formatQuestProtections(props: QuestProtections): string {
  const onOff = (b: boolean) => (b ? "on" : "off");
  const lines = [
    `  Guardian:        ${onOff(props.guardian)}`,
    `  Dialogs:         ${onOff(props.dialogs)}`,
    `  Autosleep:       ${onOff(props.autosleep)}`,
    `  Proximity close: ${onOff(props.proximityClose)}`,
  ];
  return lines.join("\n");
}
