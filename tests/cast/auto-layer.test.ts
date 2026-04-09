import { describe, expect, it } from "vitest";

/**
 * Auto-layer selection logic extracted from CastSession.
 * Bug: when layer.id === 0 and is PANEL_APP, the condition
 * `this._layerId === 0` is true, so it "selects" layer 0
 * which is a no-op (already 0).  It should instead track
 * whether a layer was ever explicitly selected.
 */

const LAYER_PANEL_APP = 0;
const LAYER_EYE_BUFFER = 1;

interface Layer {
  id: number;
  type: number;
}

function autoSelectLayer(
  layers: Layer[],
  currentLayerId: number,
  hasAutoSelected: boolean,
): { layerId: number; hasAutoSelected: boolean } {
  let layerId = currentLayerId;
  let selected = hasAutoSelected;
  for (const layer of layers) {
    if (layer.type === LAYER_PANEL_APP && !selected) {
      layerId = layer.id;
      selected = true;
    }
  }
  return { layerId, hasAutoSelected: selected };
}

describe("auto-layer selection", () => {
  it("selects first PANEL_APP layer", () => {
    const result = autoSelectLayer(
      [{ id: 5, type: LAYER_PANEL_APP }],
      0,
      false,
    );
    expect(result.layerId).toBe(5);
    expect(result.hasAutoSelected).toBe(true);
  });

  it("selects PANEL_APP with id 0", () => {
    const result = autoSelectLayer(
      [{ id: 0, type: LAYER_PANEL_APP }],
      0,
      false,
    );
    // Should still mark as selected even when id is 0
    expect(result.layerId).toBe(0);
    expect(result.hasAutoSelected).toBe(true);
  });

  it("does not re-select after first auto-selection", () => {
    const result = autoSelectLayer(
      [
        { id: 5, type: LAYER_PANEL_APP },
        { id: 9, type: LAYER_PANEL_APP },
      ],
      0,
      false,
    );
    expect(result.layerId).toBe(5); // first one wins
  });

  it("does not override manual selection", () => {
    const result = autoSelectLayer(
      [{ id: 5, type: LAYER_PANEL_APP }],
      3, // manually set
      true, // already selected
    );
    expect(result.layerId).toBe(3); // unchanged
  });

  it("ignores non-PANEL_APP layers", () => {
    const result = autoSelectLayer(
      [{ id: 2, type: LAYER_EYE_BUFFER }],
      0,
      false,
    );
    expect(result.layerId).toBe(0);
    expect(result.hasAutoSelected).toBe(false);
  });
});
