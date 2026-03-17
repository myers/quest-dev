export interface Resolution {
  width: number;
  height: number;
  label: string;
}

export const RESOLUTIONS: Record<string, Resolution> = {
  "720p":  { width: 1280, height: 720,  label: "720p" },
  "1080p": { width: 1920, height: 1080, label: "1080p" },
  "native": { width: 2064, height: 1162, label: "native" },
};

export const DEFAULT_RESOLUTION = "720p";

export function resolveResolution(
  resolution?: string,
  width?: number,
  height?: number,
): { width: number; height: number } {
  if (resolution) {
    const preset = RESOLUTIONS[resolution];
    if (!preset) {
      throw new Error(
        `Unknown resolution "${resolution}". Valid: ${Object.keys(RESOLUTIONS).join(", ")}`,
      );
    }
    return { width: preset.width, height: preset.height };
  }
  if (width != null && height != null) {
    return { width, height };
  }
  const def = RESOLUTIONS[DEFAULT_RESOLUTION];
  return { width: def.width, height: def.height };
}
