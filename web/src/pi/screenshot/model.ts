import { clampRect, type Point, type Rect, type Size } from "./geometry";

export type ToolName = "arrow" | "circle" | "text" | "crop" | "redact";

export type StrokeWidth = 2 | 4 | 8;

export const STROKE_WIDTHS: readonly StrokeWidth[] = [2, 4, 8];

export const ANNOTATION_COLOR = "#ff3b30";
export const REDACTION_COLOR = "#000000";

export interface ArrowLayer {
  readonly id: string;
  readonly kind: "arrow";
  readonly color: string;
  readonly strokeWidth: StrokeWidth;
  readonly from: Point;
  readonly to: Point;
}

export interface CircleLayer {
  readonly id: string;
  readonly kind: "circle";
  readonly color: string;
  readonly strokeWidth: StrokeWidth;
  readonly center: Point;
  readonly radius: number;
}

export interface TextLayer {
  readonly id: string;
  readonly kind: "text";
  readonly color: string;
  readonly strokeWidth: StrokeWidth;
  readonly at: Point;
  readonly text: string;
}

/** Always painted last so that no annotation can uncover redacted pixels. */
export interface RedactionLayer {
  readonly id: string;
  readonly kind: "redaction";
  readonly rect: Rect;
}

export type AnnotationLayer = ArrowLayer | CircleLayer | TextLayer;

export type Layer = AnnotationLayer | RedactionLayer;

export interface ScreenshotDocument {
  readonly image: Size;
  readonly crop: Rect;
  readonly layers: readonly Layer[];
  readonly tool: ToolName;
  readonly strokeWidth: StrokeWidth;
}

export interface EditorHistory {
  readonly doc: ScreenshotDocument;
  readonly past: readonly ScreenshotDocument[];
}

export function createDocument(image: Size): ScreenshotDocument {
  if (image.width <= 0 || image.height <= 0) {
    throw new Error("Screenshot Editor needs an image with a positive size");
  }
  return {
    image: { width: image.width, height: image.height },
    crop: { x: 0, y: 0, width: image.width, height: image.height },
    layers: [],
    tool: "arrow",
    strokeWidth: 4,
  };
}

export function setTool(doc: ScreenshotDocument, tool: ToolName): ScreenshotDocument {
  return doc.tool === tool ? doc : { ...doc, tool };
}

export function setStrokeWidth(doc: ScreenshotDocument, strokeWidth: StrokeWidth): ScreenshotDocument {
  return doc.strokeWidth === strokeWidth ? doc : { ...doc, strokeWidth };
}

export function addLayer(doc: ScreenshotDocument, layer: Layer): ScreenshotDocument {
  return { ...doc, layers: [...doc.layers, layer] };
}

export function setCrop(doc: ScreenshotDocument, crop: Rect): ScreenshotDocument {
  const clamped = clampRect(crop, doc.image);
  if (clamped.width <= 0 || clamped.height <= 0) {
    return doc;
  }
  return {
    ...doc,
    crop: {
      x: Math.round(clamped.x),
      y: Math.round(clamped.y),
      width: Math.max(1, Math.round(clamped.width)),
      height: Math.max(1, Math.round(clamped.height)),
    },
  };
}

export function resetCrop(doc: ScreenshotDocument): ScreenshotDocument {
  return setCrop(doc, { x: 0, y: 0, width: doc.image.width, height: doc.image.height });
}

export function isCropped(doc: ScreenshotDocument): boolean {
  const { crop, image } = doc;
  return (
    crop.x !== 0 ||
    crop.y !== 0 ||
    crop.width !== image.width ||
    crop.height !== image.height
  );
}

export function createHistory(doc: ScreenshotDocument): EditorHistory {
  return { doc, past: [] };
}

/** Records the current document before replacing it, so undo can restore it. */
export function commit(history: EditorHistory, next: ScreenshotDocument): EditorHistory {
  if (next === history.doc) {
    return history;
  }
  return { doc: next, past: [...history.past, history.doc] };
}

export function canUndo(history: EditorHistory): boolean {
  return history.past.length > 0;
}

export function undo(history: EditorHistory): EditorHistory {
  const previous = history.past.at(-1);
  if (!previous) {
    return history;
  }
  return { doc: previous, past: history.past.slice(0, -1) };
}
