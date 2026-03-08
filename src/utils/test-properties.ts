/**
 * Meta Scriptable Testing API (content://com.oculus.rc) utilities.
 *
 * Shared between stay-awake and cast commands for managing test mode
 * properties (guardian, autosleep, dialogs, proximity).
 */

import { execCommand, execCommandFull } from "./exec.js";

export interface TestProperties {
  disable_guardian: boolean;
  disable_dialogs: boolean;
  disable_autosleep: boolean;
  set_proximity_close: boolean;
}

/**
 * Build ADB args for SET_PROPERTY call.
 */
export function buildSetPropertyArgs(pin: string, enabled: boolean): string[] {
  return [
    "shell", "content", "call",
    "--uri", "content://com.oculus.rc",
    "--method", "SET_PROPERTY",
    "--extra", `disable_guardian:b:${enabled}`,
    "--extra", `disable_dialogs:b:${enabled}`,
    "--extra", `disable_autosleep:b:${enabled}`,
    "--extra", `set_proximity_close:b:${enabled}`,
    "--extra", `PIN:s:${pin}`,
  ];
}

/**
 * Parse GET_PROPERTY Bundle output into structured data.
 * Input: "Bundle[{disable_guardian=true, set_proximity_close=true, ...}]"
 */
export function parseTestProperties(output: string): TestProperties {
  const defaults: TestProperties = {
    disable_guardian: false,
    disable_dialogs: false,
    disable_autosleep: false,
    set_proximity_close: false,
  };

  const match = output.match(/Bundle\[\{(.+)\}\]/);
  if (!match) return defaults;

  const pairs = match[1].split(",").map((s) => s.trim());
  for (const pair of pairs) {
    const [key, value] = pair.split("=");
    if (key && value && key in defaults) {
      (defaults as unknown as Record<string, boolean>)[key] = value === "true";
    }
  }

  return defaults;
}

/**
 * Call SET_PROPERTY to enable or disable test mode.
 */
export async function setTestProperties(
  pin: string,
  enabled: boolean,
): Promise<void> {
  const args = buildSetPropertyArgs(pin, enabled);
  await execCommand("adb", args);
}

/**
 * Call GET_PROPERTY and return parsed test properties.
 */
export async function getTestProperties(): Promise<TestProperties> {
  const result = await execCommandFull("adb", [
    "shell", "content", "call",
    "--uri", "content://com.oculus.rc",
    "--method", "GET_PROPERTY",
  ]);
  return parseTestProperties(result.stdout);
}

/**
 * Format test properties for display.
 */
export function formatTestProperties(props: TestProperties): string {
  const lines = [
    `  Guardian disabled:  ${props.disable_guardian}`,
    `  Dialogs disabled:  ${props.disable_dialogs}`,
    `  Autosleep disabled: ${props.disable_autosleep}`,
    `  Proximity close:   ${props.set_proximity_close}`,
  ];
  return lines.join("\n");
}
