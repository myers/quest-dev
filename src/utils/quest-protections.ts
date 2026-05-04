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

import { execCommand, execCommandFull } from "./exec.js";
import { adbArgs } from "./adb.js";

export interface QuestProtections {
  guardian: boolean;       // true = guardian boundary active (normal)
  dialogs: boolean;        // true = system dialogs shown (normal)
  autosleep: boolean;      // true = headset will sleep when idle (normal)
  proximityClose: boolean; // true = proximity-close behavior active
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
 * Call SET_PROPERTY. `protectionsOn=true` restores Quest to normal.
 */
export async function setQuestProtections(
  pin: string,
  protectionsOn: boolean,
): Promise<void> {
  const args = adbArgs(...buildSetPropertyArgs(pin, protectionsOn));
  await execCommand("adb", args);
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
