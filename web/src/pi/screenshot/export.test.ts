import { describe, expect, it } from "vitest";

import { createPngExportPlan, EXPORT_MIME_TYPE, renderExport } from "./export";
import { addLayer, createDocument, setCrop } from "./model";
import { REDACTION_COLOR } from "./render";
import type { Canvas2DLike } from "./render";

type Call = { readonly op: string; readonly args: readonly unknown[] };

/**
 * A tiny software canvas: `drawImage` stamps source pixels and `fillRect` paints
 * opaque colour, which is enough to assert that redacted pixels are gone.
 */
class PixelCanvas implements Canvas2DLike {
  readonly calls: Call[] = [];
  readonly pixels: string[][];
  fillStyle = "#000000";
  strokeStyle = "#000000";
  lineWidth = 1;
  lineCap: CanvasLineCap = "butt";
  lineJoin: CanvasLineJoin = "miter";
  font = "10px sans-serif";
  textAlign: CanvasTextAlign = "start";
  textBaseline: CanvasTextBaseline = "alphabetic";
  globalAlpha = 1;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.pixels = Array.from({ length: height }, () => Array.from({ length: width }, () => "empty"));
  }

  private record(op: string, args: unknown[]) {
    this.calls.push({ op, args });
  }

  private paint(x: number, y: number, value: string) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return;
    }
    const row = this.pixels[y];
    if (row) {
      row[x] = value;
    }
  }

  save() {
    this.record("save", []);
  }

  restore() {
    this.record("restore", []);
  }

  clearRect(x: number, y: number, w: number, h: number) {
    this.record("clearRect", [x, y, w, h]);
  }

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
  ) {
    this.record("drawImage", [image, sx, sy, sw, sh, dx, dy, dw, dh]);
    for (let y = 0; y < Math.round(dh); y += 1) {
      for (let x = 0; x < Math.round(dw); x += 1) {
        const sourceX = Math.round(sx + ((x + 0.5) * sw) / dw);
        const sourceY = Math.round(sy + ((y + 0.5) * sh) / dh);
        this.paint(Math.round(dx) + x, Math.round(dy) + y, `source:${sourceX},${sourceY}`);
      }
    }
  }

  beginPath() {
    this.record("beginPath", []);
  }

  rect(x: number, y: number, w: number, h: number) {
    this.record("rect", [x, y, w, h]);
  }

  clip() {
    this.record("clip", []);
  }

  moveTo(x: number, y: number) {
    this.record("moveTo", [x, y]);
  }

  lineTo(x: number, y: number) {
    this.record("lineTo", [x, y]);
  }

  arc(x: number, y: number, radius: number, start: number, end: number) {
    this.record("arc", [x, y, radius, start, end]);
  }

  closePath() {
    this.record("closePath", []);
  }

  stroke() {
    this.record("stroke", [this.strokeStyle, this.lineWidth]);
  }

  fill() {
    this.record("fill", [this.fillStyle]);
  }

  fillRect(x: number, y: number, w: number, h: number) {
    this.record("fillRect", [x, y, w, h, this.fillStyle, this.globalAlpha]);
    for (let row = 0; row < Math.round(h); row += 1) {
      for (let column = 0; column < Math.round(w); column += 1) {
        this.paint(Math.round(x) + column, Math.round(y) + row, this.fillStyle);
      }
    }
  }

  fillText(text: string, x: number, y: number) {
    this.record("fillText", [text, x, y, this.font, this.fillStyle]);
  }

  setLineDash(segments: number[]) {
    this.record("setLineDash", [segments]);
  }

  pixelAt(x: number, y: number): string {
    const row = this.pixels[y];
    const value = row?.[x];
    if (value === undefined) {
      throw new Error(`pixel ${x},${y} is out of bounds`);
    }
    return value;
  }

  ops(op: string): Call[] {
    return this.calls.filter((call) => call.op === op);
  }
}

const image = { width: 100, height: 100 };
const redaction = {
  id: "redact-1",
  kind: "redaction" as const,
  rect: { x: 10, y: 10, width: 20, height: 20 },
};

describe("createPngExportPlan", () => {
  it("always exports PNG at the crop size", () => {
    const plan = createPngExportPlan(createDocument(image));
    expect(plan.mimeType).toBe(EXPORT_MIME_TYPE);
    expect(plan.width).toBe(100);
    expect(plan.height).toBe(100);

    const cropped = setCrop(createDocument(image), { x: 25, y: 20, width: 50, height: 30 });
    const croppedPlan = createPngExportPlan(cropped);
    expect(croppedPlan.width).toBe(50);
    expect(croppedPlan.height).toBe(30);
    expect(croppedPlan.crop).toEqual({ x: 25, y: 20, width: 50, height: 30 });
  });

  it("keeps annotations, then redactions last so nothing can uncover them", () => {
    const doc = addLayer(
      addLayer(createDocument(image), {
        id: "arrow-1",
        kind: "arrow",
        color: "#ff3b30",
        strokeWidth: 4,
        from: { x: 0, y: 0 },
        to: { x: 30, y: 30 },
      }),
      redaction,
    );
    const plan = createPngExportPlan(doc);
    expect(plan.layers.map((layer) => layer.id)).toEqual(["arrow-1", "redact-1"]);
  });

  it("drops layers that fall entirely outside the crop", () => {
    let doc = createDocument(image);
    doc = addLayer(doc, {
      id: "outside",
      kind: "arrow",
      color: "#ff3b30",
      strokeWidth: 4,
      from: { x: 0, y: 0 },
      to: { x: 5, y: 5 },
    });
    doc = setCrop(doc, { x: 50, y: 50, width: 50, height: 50 });
    expect(createPngExportPlan(doc).layers).toEqual([]);
  });
});

describe("renderExport", () => {
  it("sizes the drawing to the crop and translates annotation coordinates", () => {
    const doc = addLayer(
      setCrop(createDocument(image), { x: 20, y: 20, width: 60, height: 40 }),
      {
        id: "arrow-1",
        kind: "arrow",
        color: "#ff3b30",
        strokeWidth: 4,
        from: { x: 25, y: 25 },
        to: { x: 55, y: 45 },
      },
    );
    const plan = createPngExportPlan(doc);
    const canvas = new PixelCanvas(plan.width, plan.height);
    renderExport(canvas, { width: 100, height: 100 }, plan);

    const draw = canvas.ops("drawImage")[0];
    expect(draw?.args).toEqual([{ width: 100, height: 100 }, 20, 20, 60, 40, 0, 0, 60, 40]);
    expect(canvas.ops("moveTo")[0]?.args).toEqual([5, 5]);
    expect(canvas.ops("lineTo")[0]?.args).toEqual([35, 25]);
    expect(canvas.ops("lineTo")).toHaveLength(3);
    expect(canvas.ops("clip")).toHaveLength(1);
  });

  it("scales the text font with the stroke width", () => {
    const doc = addLayer(createDocument(image), {
      id: "text-1",
      kind: "text",
      color: "#ff3b30",
      strokeWidth: 8,
      at: { x: 10, y: 20 },
      text: "secret",
    });
    const plan = createPngExportPlan(doc);
    const texts = new PixelCanvas(plan.width, plan.height);
    renderExport(texts, image, plan);
    const fillText = texts.ops("fillText")[0];
    expect(fillText?.args[0]).toBe("secret");
    expect(fillText?.args[1]).toBe(10);
    expect(fillText?.args[2]).toBe(20);
    expect(String(fillText?.args[3])).toContain("36px");
  });

  it("burns redaction into opaque pixels so the original is unrecoverable", () => {
    const doc = addLayer(createDocument(image), redaction);
    const plan = createPngExportPlan(doc);
    const canvas = new PixelCanvas(plan.width, plan.height);
    renderExport(canvas, image, plan);

    for (let y = 10; y < 30; y += 1) {
      for (let x = 10; x < 30; x += 1) {
        expect(canvas.pixelAt(x, y)).toBe(REDACTION_COLOR);
      }
    }
    expect(canvas.pixelAt(9, 9)).not.toBe(REDACTION_COLOR);
    expect(canvas.pixelAt(30, 30)).not.toBe(REDACTION_COLOR);
  });

  it("paints redaction with full opacity after every annotation", () => {
    const doc = addLayer(addLayer(createDocument(image), redaction), {
      id: "text-1",
      kind: "text",
      color: "#ff3b30",
      strokeWidth: 2,
      at: { x: 12, y: 12 },
      text: "leak",
    });
    const plan = createPngExportPlan(doc);
    const canvas = new PixelCanvas(plan.width, plan.height);
    renderExport(canvas, image, plan);

    const fills = canvas.ops("fillRect");
    expect(fills).toHaveLength(1);
    expect(fills[0]?.args).toEqual([10, 10, 20, 20, REDACTION_COLOR, 1]);
    const fillIndex = canvas.calls.findIndex((call) => call.op === "fillRect");
    const textIndex = canvas.calls.findIndex((call) => call.op === "fillText");
    expect(textIndex).toBeGreaterThanOrEqual(0);
    expect(fillIndex).toBeGreaterThan(textIndex);
  });

  it("clips a redaction that hangs outside the crop", () => {
    const doc = addLayer(setCrop(createDocument(image), { x: 20, y: 20, width: 40, height: 40 }), {
      id: "redact-2",
      kind: "redaction",
      rect: { x: 0, y: 30, width: 30, height: 30 },
    });
    const plan = createPngExportPlan(doc);
    const canvas = new PixelCanvas(plan.width, plan.height);
    renderExport(canvas, image, plan);

    expect(canvas.ops("fillRect")[0]?.args).toEqual([0, 10, 10, 30, REDACTION_COLOR, 1]);
    for (let y = 10; y < 40; y += 1) {
      for (let x = 0; x < 10; x += 1) {
        expect(canvas.pixelAt(x, y)).toBe(REDACTION_COLOR);
      }
    }
    expect(canvas.pixelAt(10, 10)).not.toBe(REDACTION_COLOR);
  });
});
