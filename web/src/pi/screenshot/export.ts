import { intersectRect, type Rect } from "./geometry";
import type { Layer, ScreenshotDocument } from "./model";
import { renderExport as renderExportScene } from "./render";
import type { Canvas2DLike } from "./render";

export const EXPORT_MIME_TYPE = "image/png";


export interface PngExportPlan {
  readonly mimeType: typeof EXPORT_MIME_TYPE;
  readonly width: number;
  readonly height: number;
  readonly crop: Rect;
  /**
   * Image-space layers in paint order: annotations first, redactions last so a
   * redaction is always burned on top and cannot be uncovered.
   */
  readonly layers: readonly Layer[];
}

function isVisibleInCrop(layer: Layer, crop: Rect): boolean {
  switch (layer.kind) {
    case "arrow":
      return (
        intersectRect(boundingRect(layer.from, layer.to), crop) !== null
      );
    case "circle":
      return (
        intersectRect(
          {
            x: layer.center.x - layer.radius,
            y: layer.center.y - layer.radius,
            width: layer.radius * 2,
            height: layer.radius * 2,
          },
          crop,
        ) !== null
      );
    case "text":
      // Text is drawn from its anchor; keep it unless the anchor is far outside.
      return (
        layer.at.x >= crop.x - 200 &&
        layer.at.x <= crop.x + crop.width + 200 &&
        layer.at.y >= crop.y - 200 &&
        layer.at.y <= crop.y + crop.height + 200
      );
    case "redaction":
      return intersectRect(layer.rect, crop) !== null;
  }
}

function boundingRect(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/** Clips redactions to the crop so the exported pixels stay inside the PNG. */
function clipLayer(layer: Layer, crop: Rect): Layer | null {
  if (!isVisibleInCrop(layer, crop)) {
    return null;
  }
  if (layer.kind !== "redaction") {
    return layer;
  }
  const clipped = intersectRect(layer.rect, crop);
  return clipped ? { ...layer, rect: clipped } : null;
}

/**
 * Decides what the Saved PNG contains: the crop becomes the PNG size, and
 * every redaction is baked into the pixel output rather than kept as a layer.
 */
export function createPngExportPlan(doc: ScreenshotDocument): PngExportPlan {
  const crop = {
    x: Math.round(doc.crop.x),
    y: Math.round(doc.crop.y),
    width: Math.max(1, Math.round(doc.crop.width)),
    height: Math.max(1, Math.round(doc.crop.height)),
  };
  const annotations = doc.layers
    .filter((layer) => layer.kind !== "redaction")
    .map((layer) => clipLayer(layer, crop))
    .filter((layer): layer is Layer => layer !== null);
  const redactions = doc.layers
    .filter((layer) => layer.kind === "redaction")
    .map((layer) => clipLayer(layer, crop))
    .filter((layer): layer is Layer => layer !== null);

  return {
    mimeType: EXPORT_MIME_TYPE,
    width: crop.width,
    height: crop.height,
    crop,
    layers: [...annotations, ...redactions],
  };
}

export function renderExport(
  ctx: Canvas2DLike,
  image: unknown,
  plan: PngExportPlan,
): void {
  renderExportScene(ctx, image, plan);
}
