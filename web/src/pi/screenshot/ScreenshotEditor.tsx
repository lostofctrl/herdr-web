import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";

import { createPngExportPlan, EXPORT_MIME_TYPE, renderExport, type PngExportPlan } from "./export";
import { circleFromDrag, clientToImage, cropFromDrag, normalizeRect, type Point } from "./geometry";
import {
  ANNOTATION_COLOR,
  addLayer,
  canUndo as historyCanUndo,
  commit,
  createDocument,
  createHistory,
  isCropped,
  resetCrop,
  setCrop,
  setStrokeWidth,
  setTool,
  undo as undoHistory,
  STROKE_WIDTHS,
  type Layer,
  type ScreenshotDocument,
  type StrokeWidth,
  type ToolName,
} from "./model";
import { renderViewport } from "./render";

/** The chip image handed to the editor; width and height are the natural pixel size. */
export interface ScreenshotImage {
  src: string;
  width: number;
  height: number;
}

/** What Save returns: the PNG data URL that replaces the chip image. */
export interface ScreenshotSaveResult {
  dataUrl: string;
  width: number;
  height: number;
  plan: PngExportPlan;
  document: ScreenshotDocument;
}

/**
 * Drawing/encoding port. The default implementation uses DOM canvases; tests
 * (and any future native shell) can inject their own.
 */
export interface ScreenshotEditorSurface {
  render(
    doc: ScreenshotDocument,
    image: ScreenshotImage,
    preview?: { draft?: Layer | null; cropDraft?: ReturnType<typeof normalizeRect> | null },
  ): void;
  exportPng(doc: ScreenshotDocument, image: ScreenshotImage): ScreenshotSaveResult;
}

/**
 * Public boundary for Attachment Chips (ticket #11): mount the editor with the
 * chip image, replace the chip image in `onSave`, keep the original in `onCancel`.
 */
export interface ScreenshotEditorProps {
  image: ScreenshotImage;
  onSave: (result: ScreenshotSaveResult) => void;
  onCancel: () => void;
  /** Test/native seam; omit to use DOM canvases. */
  surface?: ScreenshotEditorSurface;
}

interface DragState {
  pointerId: number;
  from: Point;
  to: Point;
}

interface TextDraft {
  at: Point;
  value: string;
}

interface LoadedImage {
  element: HTMLImageElement;
  width: number;
  height: number;
}

const TOOLS: ReadonlyArray<{ tool: ToolName; label: string }> = [
  { tool: "arrow", label: "Arrow" },
  { tool: "circle", label: "Circle" },
  { tool: "text", label: "Text" },
  { tool: "crop", label: "Crop" },
  { tool: "redact", label: "Redact" },
];

const styles = {
  overlay: {
    position: "fixed",
    inset: 0,
    // Match modal overlays and stay above the expanded Composer (45).
    zIndex: 100,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: 12,
    background: "rgba(8, 10, 14, 0.96)",
    color: "#f4f6fb",
    overflowY: "auto",
    overscrollBehavior: "contain",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  title: { fontSize: 15, fontWeight: 600, marginRight: "auto" },
  row: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  stage: {
    flex: "1 1 auto",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 120,
    background: "#000",
    borderRadius: 10,
    overflow: "hidden",
  },
  canvas: { maxWidth: "100%", maxHeight: "100%", touchAction: "none", display: "block" },
  textForm: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" },
  input: {
    flex: "1 1 160px",
    minWidth: 120,
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid #3c4352",
    background: "#12161d",
    color: "inherit",
    fontSize: 16,
  },
  hint: { fontSize: 12, opacity: 0.72 },
} satisfies Record<string, CSSProperties>;

const buttonStyle: CSSProperties = {
  minHeight: 44,
  minWidth: 44,
  padding: "8px 12px",
  borderRadius: 10,
  border: "1px solid #3c4352",
  background: "#1b212b",
  color: "inherit",
  fontSize: 14,
  touchAction: "manipulation",
};

const activeButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "#2f6fed",
  border: "1px solid #2f6fed",
};

const disabledButtonStyle: CSSProperties = { ...buttonStyle, opacity: 0.45 };

/**
 * Isolated touch-first Screenshot Editor. It owns only pixels and callbacks:
 * the Attachment Chip decides what to do with the returned PNG.
 */
export function ScreenshotEditor({ image, onSave, onCancel, surface }: ScreenshotEditorProps) {
  const [history, setHistory] = useState(() =>
    createHistory(createDocument({ width: image.width, height: image.height })),
  );
  const doc = history.doc;
  const [drag, setDrag] = useState<DragState | null>(null);
  const [cropDraft, setCropDraft] = useState<ReturnType<typeof normalizeRect> | null>(null);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const [loaded, setLoaded] = useState<LoadedImage | null>(null);
  const [loadError, setLoadError] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const layerSeq = useRef(0);
  const nextLayerId = useCallback((kind: string) => {
    layerSeq.current += 1;
    return `${kind}-${layerSeq.current}`;
  }, []);

  useEffect(() => {
    if (surface) {
      return;
    }
    let cancelled = false;
    const element = new Image();
    element.decoding = "async";
    element.onload = () => {
      if (!cancelled) {
        setLoaded({
          element,
          width: element.naturalWidth || image.width,
          height: element.naturalHeight || image.height,
        });
      }
    };
    element.onerror = () => {
      if (!cancelled) {
        setLoadError(true);
      }
    };
    element.src = image.src;
    return () => {
      cancelled = true;
    };
  }, [image.src, image.width, image.height, surface]);

  const imageKey = `${image.src}\u0000${image.width}x${image.height}`;
  const lastImageKey = useRef(imageKey);
  useEffect(() => {
    if (lastImageKey.current === imageKey) {
      return;
    }
    lastImageKey.current = imageKey;
    layerSeq.current = 0;
    setDrag(null);
    setCropDraft(null);
    setTextDraft(null);
    setHistory(createHistory(createDocument({ width: image.width, height: image.height })));
  }, [image.height, image.width, imageKey]);

  const commitDoc = useCallback((next: ScreenshotDocument) => {
    setHistory((current) => commit(current, next));
  }, []);

  const configureDoc = useCallback((next: ScreenshotDocument) => {
    setHistory((current) => ({ ...current, doc: next }));
  }, []);

  const draft = useMemo<Layer | null>(() => {
    if (!drag) {
      return null;
    }
    switch (doc.tool) {
      case "arrow":
        return {
          id: "draft-arrow",
          kind: "arrow",
          color: ANNOTATION_COLOR,
          strokeWidth: doc.strokeWidth,
          from: drag.from,
          to: drag.to,
        };
      case "circle": {
        const { center, radius } = circleFromDrag(drag.from, drag.to);
        return {
          id: "draft-circle",
          kind: "circle",
          color: ANNOTATION_COLOR,
          strokeWidth: doc.strokeWidth,
          center,
          radius,
        };
      }
      case "redact": {
        const rect = normalizeRect(drag.from, drag.to);
        return { id: "draft-redaction", kind: "redaction", rect };
      }
      default:
        return null;
    }
  }, [doc.strokeWidth, doc.tool, drag]);

  const liveCropDraft = useMemo(() => {
    if (cropDraft) {
      return cropDraft;
    }
    if (!drag || doc.tool !== "crop") {
      return null;
    }
    const bounds = { width: doc.image.width, height: doc.image.height };
    return cropFromDrag(drag.from, drag.to, bounds);
  }, [cropDraft, doc.image.height, doc.image.width, doc.tool, drag]);

  useEffect(() => {
    const preview = { draft, cropDraft: liveCropDraft };
    if (surface) {
      surface.render(doc, image, preview);
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas || !loaded) {
      return;
    }
    canvas.width = Math.max(1, Math.round(doc.crop.width));
    canvas.height = Math.max(1, Math.round(doc.crop.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    renderViewport(ctx, loaded.element, doc, {
      width: canvas.width,
      height: canvas.height,
      draft,
      cropDraft: liveCropDraft,
    });
  }, [doc, draft, image, liveCropDraft, loaded, surface]);

  const imagePoint = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
      const bounds = event.currentTarget.getBoundingClientRect();
      return clientToImage(
        { x: event.clientX, y: event.clientY },
        {
          left: bounds.left,
          top: bounds.top,
          width: bounds.width,
          height: bounds.height,
          crop: doc.crop,
        },
      );
    },
    [doc.crop],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!event.isPrimary || event.button !== 0) {
        return;
      }
      // Keep the terminal keyboard and native touch gestures out of the canvas.
      event.preventDefault();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is a convenience; the pointerup handler still commits.
      }
      const at = imagePoint(event);
      if (doc.tool === "text") {
        setTextDraft({ at, value: "" });
        return;
      }
      setDrag({ pointerId: event.pointerId, from: at, to: at });
    },
    [doc.tool, imagePoint],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }
      event.preventDefault();
      const at = imagePoint(event);
      setDrag((current) => (current ? { ...current, to: at } : current));
    },
    [drag, imagePoint],
  );

  const finishDrag = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }
      const to = imagePoint(event);
      setDrag(null);
      switch (doc.tool) {
        case "arrow": {
          if (Math.hypot(to.x - drag.from.x, to.y - drag.from.y) < 2) {
            return;
          }
          commitDoc(
            addLayer(doc, {
              id: nextLayerId("arrow"),
              kind: "arrow",
              color: ANNOTATION_COLOR,
              strokeWidth: doc.strokeWidth,
              from: drag.from,
              to,
            }),
          );
          return;
        }
        case "circle": {
          const { center, radius } = circleFromDrag(drag.from, to);
          if (radius < 1) {
            return;
          }
          commitDoc(
            addLayer(doc, {
              id: nextLayerId("circle"),
              kind: "circle",
              color: ANNOTATION_COLOR,
              strokeWidth: doc.strokeWidth,
              center,
              radius,
            }),
          );
          return;
        }
        case "redact": {
          const rect = normalizeRect(drag.from, to);
          if (rect.width < 2 || rect.height < 2) {
            return;
          }
          commitDoc(addLayer(doc, { id: nextLayerId("redact"), kind: "redaction", rect }));
          return;
        }
        case "crop": {
          setCropDraft(
            cropFromDrag(drag.from, to, { width: doc.image.width, height: doc.image.height }),
          );
          return;
        }
        default:
          return;
      }
    },
    [commitDoc, doc, drag, imagePoint, nextLayerId],
  );

  const handlePointerCancel = useCallback(() => {
    setDrag(null);
  }, []);

  const handleTool = useCallback(
    (tool: ToolName) => {
      setDrag(null);
      setTextDraft(null);
      configureDoc(setTool(doc, tool));
    },
    [configureDoc, doc],
  );

  const handleStroke = useCallback(
    (strokeWidth: StrokeWidth) => {
      configureDoc(setStrokeWidth(doc, strokeWidth));
    },
    [configureDoc, doc],
  );

  const handleUndo = useCallback(() => {
    setDrag(null);
    setCropDraft(null);
    setTextDraft(null);
    setHistory((current) => undoHistory(current));
  }, []);

  const handleApplyCrop = useCallback(() => {
    if (!liveCropDraft) {
      return;
    }
    commitDoc(setCrop(doc, liveCropDraft));
    setCropDraft(null);
    setDrag(null);
  }, [commitDoc, doc, liveCropDraft]);

  const handleResetCrop = useCallback(() => {
    commitDoc(resetCrop(doc));
    setCropDraft(null);
    setDrag(null);
  }, [commitDoc, doc]);

  const handleAddText = useCallback(() => {
    if (!textDraft) {
      return;
    }
    const text = textDraft.value.trim();
    setTextDraft(null);
    if (!text) {
      return;
    }
    commitDoc(
      addLayer(doc, {
        id: nextLayerId("text"),
        kind: "text",
        color: ANNOTATION_COLOR,
        strokeWidth: doc.strokeWidth,
        at: textDraft.at,
        text,
      }),
    );
  }, [commitDoc, doc, nextLayerId, textDraft]);

  const handleSave = useCallback(() => {
    const activeSurface =
      surface ??
      (loaded && canvasRef.current
        ? createDomSurface(canvasRef.current, loaded.element)
        : null);
    if (!activeSurface) {
      return;
    }
    onSave(activeSurface.exportPng(doc, image));
  }, [doc, image, loaded, onSave, surface]);

  const ready = surface !== undefined || loaded !== null;

  return (
    <div role="dialog" aria-modal="true" aria-label="Screenshot Editor" style={styles.overlay}>
      <div style={styles.header}>
        <span style={styles.title}>Screenshot Editor</span>
        <button type="button" style={buttonStyle} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          style={historyCanUndo(history) ? buttonStyle : disabledButtonStyle}
          disabled={!historyCanUndo(history)}
          onClick={handleUndo}
        >
          Undo
        </button>
        <button
          type="button"
          style={ready ? activeButtonStyle : disabledButtonStyle}
          disabled={!ready}
          onClick={handleSave}
        >
          Save
        </button>
      </div>

      <div style={styles.row} role="toolbar" aria-label="Tools">
        {TOOLS.map(({ tool, label }) => (
          <button
            key={tool}
            type="button"
            style={doc.tool === tool ? activeButtonStyle : buttonStyle}
            aria-pressed={doc.tool === tool}
            onClick={() => handleTool(tool)}
          >
            {label}
          </button>
        ))}
        <span style={styles.hint}>Stroke</span>
        {STROKE_WIDTHS.map((width) => (
          <button
            key={width}
            type="button"
            style={doc.strokeWidth === width ? activeButtonStyle : buttonStyle}
            aria-pressed={doc.strokeWidth === width}
            onClick={() => handleStroke(width)}
          >
            {`Stroke ${width} px`}
          </button>
        ))}
      </div>

      <div style={styles.stage}>
        <canvas
          ref={canvasRef}
          aria-label="Image canvas"
          style={styles.canvas}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={handlePointerCancel}
        />
      </div>

      {doc.tool === "text" && textDraft ? (
        <form
          style={styles.textForm}
          onSubmit={(event) => {
            event.preventDefault();
            handleAddText();
          }}
        >
          <input
            aria-label="Annotation text"
            style={styles.input}
            value={textDraft.value}
            autoFocus
            onChange={(event) =>
              setTextDraft((current) =>
                current ? { ...current, value: event.target.value } : current,
              )
            }
          />
          <button type="submit" style={buttonStyle}>
            Add text
          </button>
          <button type="button" style={buttonStyle} onClick={() => setTextDraft(null)}>
            Cancel text
          </button>
        </form>
      ) : null}

      {doc.tool === "crop" ? (
        <div style={styles.row}>
          <span style={styles.hint}>
            {liveCropDraft
              ? `Crop ${Math.round(liveCropDraft.width)} × ${Math.round(liveCropDraft.height)}`
              : "Drag on the image to choose a crop"}
          </span>
          <button
            type="button"
            style={liveCropDraft ? buttonStyle : disabledButtonStyle}
            disabled={!liveCropDraft}
            onClick={handleApplyCrop}
          >
            Apply crop
          </button>
          <button
            type="button"
            style={isCropped(doc) ? buttonStyle : disabledButtonStyle}
            disabled={!isCropped(doc)}
            onClick={handleResetCrop}
          >
            Clear crop
          </button>
        </div>
      ) : null}

      <div style={styles.row}>
        <span style={styles.hint}>
          {loadError
            ? "This image could not be loaded."
            : `${doc.crop.width} × ${doc.crop.height} px · ${doc.layers.length} mark${
                doc.layers.length === 1 ? "" : "s"
              }`}
        </span>
      </div>
    </div>
  );
}

/** DOM-canvas implementation of the drawing port. */
export function createDomSurface(
  canvas: HTMLCanvasElement,
  element: CanvasImageSource & { naturalWidth?: number },
): ScreenshotEditorSurface {
  return {
    render(doc, _image, preview) {
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }
      canvas.width = Math.max(1, Math.round(doc.crop.width));
      canvas.height = Math.max(1, Math.round(doc.crop.height));
      renderViewport(ctx, element, doc, {
        width: canvas.width,
        height: canvas.height,
        draft: preview?.draft ?? null,
        cropDraft: preview?.cropDraft ?? null,
      });
    },
    exportPng(doc) {
      const plan = createPngExportPlan(doc);
      const output = document.createElement("canvas");
      output.width = plan.width;
      output.height = plan.height;
      const ctx = output.getContext("2d");
      if (!ctx) {
        throw new Error("Canvas 2D rendering is unavailable");
      }
      renderExport(ctx, element, plan);
      const dataUrl = output.toDataURL(EXPORT_MIME_TYPE);
      return { dataUrl, width: plan.width, height: plan.height, plan, document: doc };
    },
  };
}
