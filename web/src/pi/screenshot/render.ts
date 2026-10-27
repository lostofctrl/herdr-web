import { arrowHead, type Rect } from "./geometry";
import {
  ANNOTATION_COLOR,
  REDACTION_COLOR,
  type Layer,
  type ScreenshotDocument,
  type StrokeWidth,
} from "./model";

export { ANNOTATION_COLOR, REDACTION_COLOR } from "./model";

/** The subset of the Canvas 2D API the editor draws with. */
export interface Canvas2DLike {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  globalAlpha: number;
  save(): void;
  restore(): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  drawImage(
    image: unknown,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
  beginPath(): void;
  rect(x: number, y: number, w: number, h: number): void;
  clip(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, radius: number, start: number, end: number): void;
  closePath(): void;
  stroke(): void;
  fill(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  setLineDash(segments: number[]): void;
}

export interface RenderViewportOptions {
  width: number;
  height: number;
  /** In-progress annotation, drawn above committed layers. */
  draft?: Layer | null;
  /** In-progress crop selection, drawn as a dashed outline. */
  cropDraft?: Rect | null;
}

export function textFontSize(strokeWidth: StrokeWidth): number {
  return 12 + strokeWidth * 3;
}

function hasArea(layer: Layer): boolean {
  switch (layer.kind) {
    case "arrow":
    case "circle":
    case "text":
      return true;
    case "redaction":
      return layer.rect.width > 0 && layer.rect.height > 0;
  }
}

function drawAnnotation(
  ctx: Canvas2DLike,
  layer: Exclude<Layer, { kind: "redaction" }>,
  offsetX: number,
  offsetY: number,
  scale: number,
): void {
  ctx.strokeStyle = layer.color || ANNOTATION_COLOR;
  ctx.lineWidth = Math.max(1, layer.strokeWidth * scale);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (layer.kind === "arrow") {
    const from = { x: (layer.from.x - offsetX) * scale, y: (layer.from.y - offsetY) * scale };
    const to = { x: (layer.to.x - offsetX) * scale, y: (layer.to.y - offsetY) * scale };
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();

    const head = arrowHead(from, to, layer.strokeWidth * scale);
    if (head.length > 0) {
      ctx.beginPath();
      ctx.moveTo(head.left.x, head.left.y);
      ctx.lineTo(to.x, to.y);
      ctx.lineTo(head.right.x, head.right.y);
      ctx.stroke();
    }
    return;
  }

  if (layer.kind === "circle") {
    ctx.beginPath();
    ctx.arc(
      (layer.center.x - offsetX) * scale,
      (layer.center.y - offsetY) * scale,
      Math.max(0, layer.radius * scale),
      0,
      Math.PI * 2,
    );
    ctx.closePath();
    ctx.stroke();
    return;
  }

  ctx.fillStyle = layer.color || ANNOTATION_COLOR;
  ctx.textAlign = "start";
  ctx.textBaseline = "top";
  ctx.font = `${textFontSize(layer.strokeWidth) * scale}px system-ui, sans-serif`;
  ctx.fillText(
    layer.text,
    (layer.at.x - offsetX) * scale,
    (layer.at.y - offsetY) * scale,
  );
}

function drawRedaction(
  ctx: Canvas2DLike,
  rect: Rect,
  offsetX: number,
  offsetY: number,
  scale: number,
): void {
  // Opaque fill with a reset alpha: redacted pixels must not be recoverable.
  ctx.globalAlpha = 1;
  ctx.fillStyle = REDACTION_COLOR;
  ctx.fillRect(
    (rect.x - offsetX) * scale,
    (rect.y - offsetY) * scale,
    rect.width * scale,
    rect.height * scale,
  );
}

function drawLayers(
  ctx: Canvas2DLike,
  layers: readonly Layer[],
  draft: Layer | null,
  offsetX: number,
  offsetY: number,
  scale: number,
): void {
  const annotations = layers.filter(
    (layer): layer is Exclude<Layer, { kind: "redaction" }> => layer.kind !== "redaction",
  );
  const redactions = layers.filter(
    (layer): layer is Extract<Layer, { kind: "redaction" }> => layer.kind === "redaction",
  );
  const draftAnnotation = draft && draft.kind !== "redaction" ? draft : null;
  const draftRedaction = draft && draft.kind === "redaction" ? draft : null;

  for (const layer of annotations.filter(hasArea)) {
    drawAnnotation(ctx, layer, offsetX, offsetY, scale);
  }
  if (draftAnnotation && hasArea(draftAnnotation)) {
    drawAnnotation(ctx, draftAnnotation, offsetX, offsetY, scale);
  }
  for (const layer of redactions.filter(hasArea)) {
    drawRedaction(ctx, layer.rect, offsetX, offsetY, scale);
  }
  if (draftRedaction) {
    drawRedaction(ctx, draftRedaction.rect, offsetX, offsetY, scale);
  }
}

function drawCropDraft(ctx: Canvas2DLike, rect: Rect, offsetX: number, offsetY: number, scale: number) {
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = Math.max(1, 2 * scale);
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.rect(
    (rect.x - offsetX) * scale,
    (rect.y - offsetY) * scale,
    rect.width * scale,
    rect.height * scale,
  );
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Paints the cropped document into an on-screen canvas. */
export function renderViewport(
  ctx: Canvas2DLike,
  image: unknown,
  doc: ScreenshotDocument,
  options: RenderViewportOptions,
): void {
  const scaleX = options.width / doc.crop.width;
  const scaleY = options.height / doc.crop.height;
  ctx.save();
  ctx.clearRect(0, 0, options.width, options.height);
  ctx.beginPath();
  ctx.rect(0, 0, options.width, options.height);
  ctx.clip();
  ctx.drawImage(
    image,
    doc.crop.x,
    doc.crop.y,
    doc.crop.width,
    doc.crop.height,
    0,
    0,
    options.width,
    options.height,
  );
  drawLayers(
    ctx,
    doc.layers,
    options.draft ?? null,
    doc.crop.x,
    doc.crop.y,
    Math.max(scaleX, scaleY),
  );
  if (options.cropDraft) {
    drawCropDraft(
      ctx,
      options.cropDraft,
      doc.crop.x,
      doc.crop.y,
      Math.max(scaleX, scaleY),
    );
  }
  ctx.restore();
}

/** Paints an export plan at 1:1 pixels; used for the PNG that replaces the chip image. */
export function renderExport(
  ctx: Canvas2DLike,
  image: unknown,
  plan: { width: number; height: number; crop: Rect; layers: readonly Layer[] },
): void {
  renderViewport(ctx, image, {
    image: { width: plan.crop.width, height: plan.crop.height },
    crop: plan.crop,
    layers: plan.layers,
    tool: "arrow",
    strokeWidth: 4,
  }, { width: plan.width, height: plan.height });
}
