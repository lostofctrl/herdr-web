import { describe, expect, it } from "vitest";

import {
  arrowHead,
  circleFromDrag,
  clampRect,
  clientToImage,
  cropFromDrag,
  intersectRect,
  normalizeRect,
  rectWithin,
} from "./geometry";

describe("normalizeRect", () => {
  it("turns any drag direction into a positive rect", () => {
    expect(normalizeRect({ x: 30, y: 40 }, { x: 10, y: 10 })).toEqual({
      x: 10,
      y: 10,
      width: 20,
      height: 30,
    });
  });
});

describe("clampRect", () => {
  it("keeps a rect inside the image bounds", () => {
    expect(clampRect({ x: -10, y: 80, width: 40, height: 40 }, { width: 100, height: 100 })).toEqual({
      x: 0,
      y: 80,
      width: 30,
      height: 20,
    });
  });

  it("collapses a rect fully outside the image to empty", () => {
    const clamped = clampRect({ x: 200, y: 200, width: 10, height: 10 }, { width: 100, height: 100 });
    expect(clamped.width).toBe(0);
    expect(clamped.height).toBe(0);
    expect(rectWithin(clamped, { width: 100, height: 100 })).toBe(true);
  });
});

describe("intersectRect", () => {
  it("returns the overlap of two rects", () => {
    expect(
      intersectRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }),
    ).toEqual({ x: 5, y: 5, width: 5, height: 5 });
  });

  it("returns null when the rects do not overlap", () => {
    expect(
      intersectRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 5, height: 5 }),
    ).toBeNull();
  });
});

describe("circleFromDrag", () => {
  it("centres the circle on the drag and uses half the diagonal as radius", () => {
    expect(circleFromDrag({ x: 10, y: 10 }, { x: 30, y: 30 })).toEqual({
      center: { x: 20, y: 20 },
      radius: Math.hypot(10, 10),
    });
  });

  it("supports drags in any direction", () => {
    const circle = circleFromDrag({ x: 30, y: 30 }, { x: 10, y: 10 });
    expect(circle.center).toEqual({ x: 20, y: 20 });
    expect(circle.radius).toBeCloseTo(Math.hypot(10, 10));
  });
});

describe("arrowHead", () => {
  it("puts both wings the same distance from the tip at 30 degrees off the shaft", () => {
    const from = { x: 0, y: 0 };
    const to = { x: 100, y: 0 };
    const head = arrowHead(from, to, 4);
    expect(head.length).toBeGreaterThan(0);
    for (const wing of [head.left, head.right]) {
      expect(Math.hypot(wing.x - to.x, wing.y - to.y)).toBeCloseTo(head.length);
      const shaft = { x: from.x - to.x, y: from.y - to.y };
      const wingVector = { x: wing.x - to.x, y: wing.y - to.y };
      const cosine =
        (shaft.x * wingVector.x + shaft.y * wingVector.y) /
        (Math.hypot(shaft.x, shaft.y) * Math.hypot(wingVector.x, wingVector.y));
      expect(Math.acos(Math.max(-1, Math.min(1, cosine)))).toBeCloseTo(Math.PI / 6);
    }
  });

  it("does not explode on a zero-length shaft", () => {
    const head = arrowHead({ x: 5, y: 5 }, { x: 5, y: 5 }, 8);
    expect(head.length).toBe(0);
    expect(head.left).toEqual({ x: 5, y: 5 });
  });
});

describe("cropFromDrag", () => {
  it("clamps the drag to the image", () => {
    expect(cropFromDrag({ x: 90, y: 90 }, { x: 200, y: 200 }, { width: 100, height: 100 })).toEqual({
      x: 90,
      y: 90,
      width: 10,
      height: 10,
    });
  });

  it("treats a tap as no crop by returning the full image", () => {
    expect(cropFromDrag({ x: 50, y: 50 }, { x: 51, y: 51 }, { width: 100, height: 100 })).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
  });
});

describe("clientToImage", () => {
  const viewport = {
    left: 20,
    top: 10,
    width: 200,
    height: 100,
    crop: { x: 50, y: 50, width: 100, height: 50 },
  };

  it("maps client coordinates onto image coordinates through the crop", () => {
    expect(clientToImage({ x: 20, y: 10 }, viewport)).toEqual({ x: 50, y: 50 });
    expect(clientToImage({ x: 120, y: 60 }, viewport)).toEqual({ x: 100, y: 75 });
  });

  it("clamps coordinates that fall outside the canvas", () => {
    expect(clientToImage({ x: -100, y: 500 }, viewport)).toEqual({ x: 50, y: 100 });
  });
});
