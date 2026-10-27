/**
 * Screenshot Editor boundary for Attachment Chips (ticket #11).
 *
 * A chip only needs two things:
 * - render `<ScreenshotEditor image={...} onSave={...} onCancel={...} />`
 * - replace its own image with `result.dataUrl` in `onSave`; do nothing in `onCancel`.
 *
 * Everything under `web/src/pi/screenshot/` is self-contained and has no
 * dependency on the terminal, the bridge or the rest of the Pi mode UI.
 */
export { ScreenshotEditor, createDomSurface } from "./ScreenshotEditor";
export type {
  ScreenshotEditorProps,
  ScreenshotEditorSurface,
  ScreenshotImage,
  ScreenshotSaveResult,
} from "./ScreenshotEditor";
export {
  createPngExportPlan,
  EXPORT_MIME_TYPE,
  renderExport,
  type PngExportPlan,
} from "./export";
export {
  arrowHead,
  circleFromDrag,
  clampRect,
  clientToImage,
  cropFromDrag,
  intersectRect,
  normalizeRect,
  rectWithin,
  MIN_CROP_SIZE,
  type Point,
  type Rect,
  type Size,
  type Viewport,
} from "./geometry";
export {
  addLayer,
  ANNOTATION_COLOR,
  canUndo,
  commit,
  createDocument,
  createHistory,
  isCropped,
  REDACTION_COLOR,
  resetCrop,
  setCrop,
  setStrokeWidth,
  setTool,
  STROKE_WIDTHS,
  undo,
  type AnnotationLayer,
  type ArrowLayer,
  type CircleLayer,
  type EditorHistory,
  type Layer,
  type RedactionLayer,
  type ScreenshotDocument,
  type StrokeWidth,
  type TextLayer,
  type ToolName,
} from "./model";
export { renderViewport, textFontSize, type Canvas2DLike } from "./render";
