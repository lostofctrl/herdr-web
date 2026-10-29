import { describe, expect, it } from "vitest";
import { piComposerViewport } from "./piComposerViewport";

describe("mobile Composer visible viewport", () => {
  it("fits keyboard and panned/rotated visible bounds, not layout viewport height", () => {
    expect(piComposerViewport({ width: 390, height: 320, offsetLeft: 3, offsetTop: 52 }, 800, 900))
      .toEqual({ left: 3, top: 52, width: 390, height: 320 });
    expect(piComposerViewport({ width: 740, height: 240, offsetLeft: 0, offsetTop: 0 }, 800, 900))
      .toEqual({ left: 0, top: 0, width: 740, height: 240 });
  });
  it("uses window bounds without visualViewport support", () => {
    expect(piComposerViewport(null, 393, 852)).toEqual({ left: 0, top: 0, width: 393, height: 852 });
  });
});
