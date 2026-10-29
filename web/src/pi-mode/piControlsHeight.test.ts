import { describe, expect, it } from "vitest";

import { piControlsStackHeight } from "./piControlsHeight";

describe("piControlsStackHeight", () => {
  it("sums the Key Bar and the Composer", () => {
    expect(piControlsStackHeight(51, 105)).toBe(156);
  });

  it("uses whichever part is mounted", () => {
    expect(piControlsStackHeight(null, 105)).toBe(105);
    expect(piControlsStackHeight(51, null)).toBe(51);
  });

  it("reports nothing when neither part is mounted", () => {
    expect(piControlsStackHeight(null, null)).toBeNull();
  });
});
