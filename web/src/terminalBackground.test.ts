import { describe, expect, it, vi } from "vitest";
import { installTerminalBackgroundPixelAlignment } from "./terminalBackground";

describe("terminal background pixel alignment", () => {
  it("snaps shared row and cell boundaries at fractional display scales", () => {
    const rectangles: number[][] = [];
    const context = {
      getTransform: () => ({ a: 1.25, d: 1.25, e: 0, f: 0 }),
      fillRect: (x: number, y: number, w: number, h: number) => rectangles.push([x, y, w, h]),
    };
    const renderer = {
      ctx: context,
      renderLine() {
        context.fillRect(0, 0, 27, 17);
        context.fillRect(0, 0, 9, 17);
        context.fillRect(9, 0, 9, 17);
        context.fillRect(18, 0, 9, 17);
        context.fillRect(0, 17, 9, 17);
      },
    };
    installTerminalBackgroundPixelAlignment(renderer);
    renderer.renderLine();
    const pixels = rectangles.map(([x, y, w, h]) => [x, y, x + w, y + h].map(v => Math.round(v * 1.25 * 100) / 100));
    expect(pixels).toEqual([
      [0, 0, 34, 21], [0, 0, 11, 21], [11, 0, 23, 21],
      [23, 0, 34, 21], [0, 21, 11, 43],
    ]);
  });

  it("restores the canvas method even if rendering throws", () => {
    const fillRect = vi.fn();
    const context = { fillRect, getTransform: () => ({ a: 1.25, d: 1.25, e: 0, f: 0 }) };
    const renderer = { ctx: context, renderLine() { throw new Error("draw failed"); } };
    installTerminalBackgroundPixelAlignment(renderer);
    expect(() => renderer.renderLine()).toThrow("draw failed");
    expect(context.fillRect).toBe(fillRect);
  });
});
