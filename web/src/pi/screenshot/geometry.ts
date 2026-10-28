export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Nullable size used for crop drafts before a real crop is applied. */
export interface Viewport {
  /** Bounding client rect of the canvas in CSS pixels. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Region of the image currently shown. */
  crop: Rect;
}

export const MIN_CROP_SIZE = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Converts a drag in any direction into a positive rect. */
export function normalizeRect(from: Point, to: Point): Rect {
  const x = Math.min(from.x, to.x);
  const y = Math.min(from.y, to.y);
  return { x, y, width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) };
}

/** Clamps a rect into the image, keeping width and height non-negative. */
export function clampRect(rect: Rect, bounds: Size): Rect {
  const x = clamp(rect.x, 0, bounds.width);
  const y = clamp(rect.y, 0, bounds.height);
  const right = clamp(rect.x + rect.width, 0, bounds.width);
  const bottom = clamp(rect.y + rect.height, 0, bounds.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

export function rectWithin(rect: Rect, bounds: Size): boolean {
  return (
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.width <= bounds.width &&
    rect.y + rect.height <= bounds.height
  );
}

/** Returns the overlap of two rects, or null when they do not overlap. */
export function intersectRect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) {
    return null;
  }
  return { x, y, width: right - x, height: bottom - y };
}

export function circleFromDrag(from: Point, to: Point): { center: Point; radius: number } {
  return {
    center: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
    radius: Math.hypot(to.x - from.x, to.y - from.y) / 2,
  };
}

/** Two arrow wings at 30 degrees from the shaft, sized so thick strokes stay readable. */
export function arrowHead(
  from: Point,
  to: Point,
  strokeWidth: number,
): { left: Point; right: Point; length: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const shaft = Math.hypot(dx, dy);
  if (shaft === 0) {
    return { left: { ...to }, right: { ...to }, length: 0 };
  }
  const length = 10 + strokeWidth * 2.5;
  const base = Math.atan2(dy, dx);
  const spread = Math.PI / 6;
  return {
    left: {
      x: to.x - length * Math.cos(base - spread),
      y: to.y - length * Math.sin(base - spread),
    },
    right: {
      x: to.x - length * Math.cos(base + spread),
      y: to.y - length * Math.sin(base + spread),
    },
    length,
  };
}

/**
 * Crop selection from a drag. A tap or a tiny drag means "no crop" and returns
 * the full image so that a mis-tap never shrinks the export.
 */
export function cropFromDrag(from: Point, to: Point, bounds: Size): Rect {
  const dragged = clampRect(normalizeRect(from, to), bounds);
  if (dragged.width < MIN_CROP_SIZE || dragged.height < MIN_CROP_SIZE) {
    return { x: 0, y: 0, width: bounds.width, height: bounds.height };
  }
  return dragged;
}

/** Maps browser client coordinates onto image coordinates through the current crop. */
export function clientToImage(client: Point, viewport: Viewport): Point {
  const scaleX = viewport.width === 0 ? 1 : viewport.crop.width / viewport.width;
  const scaleY = viewport.height === 0 ? 1 : viewport.crop.height / viewport.height;
  return {
    x: clamp(
      viewport.crop.x + (client.x - viewport.left) * scaleX,
      viewport.crop.x,
      viewport.crop.x + viewport.crop.width,
    ),
    y: clamp(
      viewport.crop.y + (client.y - viewport.top) * scaleY,
      viewport.crop.y,
      viewport.crop.y + viewport.crop.height,
    ),
  };
}
