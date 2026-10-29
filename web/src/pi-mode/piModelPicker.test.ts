import { describe, expect, it } from "vitest";
import { filterPiModels, piModelKey, piModelPickerPlacement } from "./piModelPicker";

describe("Pi model search", () => {
  const models = [{id:"same",provider:"one",label:"Alpha Fast"},{id:"same",provider:"two",label:"Beta Fast"}];
  it("matches all terms across label, id and provider, case insensitively", () => {
    expect(filterPiModels(models, " TWO fast SAME ")).toEqual([models[1]]);
    expect(filterPiModels(models, "absent")).toEqual([]);
    expect(filterPiModels(models, "")).toEqual(models);
  });
  it("keeps provider/id identities distinct", () => {
    expect(piModelKey(models[0])).not.toBe(piModelKey(models[1]));
  });
});

describe("Pi model panel placement", () => {
  const viewport = { width: 1280, height: 900 };

  it("stays on screen when the trigger sits at the left edge of a pane", () => {
    const placement = piModelPickerPlacement({ top: 700, bottom: 736, left: 0 }, viewport);
    expect(placement.left).toBe(8);
    expect(placement.width).toBe(352);
    expect(placement.left + placement.width).toBeLessThanOrEqual(viewport.width);
  });

  it("pulls a panel that would overflow the right edge back inside", () => {
    const placement = piModelPickerPlacement({ top: 700, bottom: 736, left: 1240 }, viewport);
    expect(placement.left + placement.width).toBeLessThanOrEqual(viewport.width - 8);
  });

  it("never exceeds a narrow phone viewport", () => {
    const phone = { width: 320, height: 700 };
    const placement = piModelPickerPlacement({ top: 400, bottom: 436, left: 12 }, phone);
    expect(placement.width).toBe(304);
    expect(placement.left).toBe(8);
    expect(placement.left + placement.width).toBeLessThanOrEqual(phone.width);
  });

  it("opens above the trigger when there is room", () => {
    const placement = piModelPickerPlacement({ top: 700, bottom: 736, left: 40 }, viewport);
    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(700);
    expect(placement.maxHeight).toBeGreaterThan(160);
  });

  it("flips below a trigger that sits too close to the top instead of clipping", () => {
    const placement = piModelPickerPlacement({ top: 100, bottom: 144, left: 40 }, viewport);
    // Above the trigger there are only 84px, so the panel opens below its bottom edge.
    expect(placement.top).toBe(152);
    expect(placement.maxHeight).toBeLessThanOrEqual(viewport.height - 152 - 8);
    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(viewport.height - 8);
  });

  it("clears the trigger instead of covering it when it opens below", () => {
    for (const height of [23, 36, 44]) {
      const placement = piModelPickerPlacement(
        { top: 20, bottom: 20 + height, left: 40 },
        { width: 390, height: 400 },
      );
      expect(placement.top).toBe(20 + height + 8);
    }
  });

  it("never renders outside the vertical viewport for any trigger position", () => {
    for (let top = 0; top <= 900; top += 25) {
      const placement = piModelPickerPlacement({ top, bottom: top + 36, left: 40 }, viewport);
      expect(placement.top).toBeGreaterThanOrEqual(8);
      expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(viewport.height - 8);
    }
  });
});
