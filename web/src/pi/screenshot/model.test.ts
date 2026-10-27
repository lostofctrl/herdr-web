import { describe, expect, it } from "vitest";

import {
  addLayer,
  canUndo,
  commit,
  createDocument,
  createHistory,
  resetCrop,
  setCrop,
  setStrokeWidth,
  setTool,
  undo,
  type ArrowLayer,
  type CircleLayer,
} from "./model";

const image = { width: 200, height: 100 };

const arrow: ArrowLayer = {
  id: "arrow-1",
  kind: "arrow",
  color: "#ff3b30",
  strokeWidth: 4,
  from: { x: 10, y: 10 },
  to: { x: 60, y: 40 },
};

const circle: CircleLayer = {
  id: "circle-1",
  kind: "circle",
  color: "#ff3b30",
  strokeWidth: 4,
  center: { x: 100, y: 50 },
  radius: 20,
};

describe("createDocument", () => {
  it("starts uncropped with no layers", () => {
    const doc = createDocument(image);
    expect(doc.crop).toEqual({ x: 0, y: 0, width: 200, height: 100 });
    expect(doc.layers).toEqual([]);
    expect(doc.tool).toBe("arrow");
    expect(doc.strokeWidth).toBe(4);
  });

  it("rejects an image with no area", () => {
    expect(() => createDocument({ width: 0, height: 100 })).toThrow();
  });
});

describe("tool and stroke settings", () => {
  it("changes the active tool without touching layers", () => {
    const doc = addLayer(createDocument(image), arrow);
    const next = setTool(doc, "crop");
    expect(next.tool).toBe("crop");
    expect(next.layers).toBe(doc.layers);
    expect(doc.tool).toBe("arrow");
  });

  it("changes the stroke width without touching layers", () => {
    const doc = createDocument(image);
    expect(setStrokeWidth(doc, 8).strokeWidth).toBe(8);
    expect(setStrokeWidth(doc, 2).strokeWidth).toBe(2);
  });
});

describe("setCrop", () => {
  it("clamps the crop to the image", () => {
    const doc = setCrop(createDocument(image), { x: 150, y: 50, width: 100, height: 100 });
    expect(doc.crop).toEqual({ x: 150, y: 50, width: 50, height: 50 });
  });

  it("clears back to the full image", () => {
    const cropped = setCrop(createDocument(image), { x: 10, y: 10, width: 50, height: 50 });
    expect(resetCrop(cropped).crop).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  });
});

describe("history", () => {
  it("cannot undo a fresh document", () => {
    const history = createHistory(createDocument(image));
    expect(canUndo(history)).toBe(false);
    expect(undo(history).doc).toBe(history.doc);
  });

  it("undoes added layers in order", () => {
    let history = createHistory(createDocument(image));
    history = commit(history, addLayer(history.doc, arrow));
    history = commit(history, addLayer(history.doc, circle));
    expect(history.doc.layers.map((layer) => layer.id)).toEqual(["arrow-1", "circle-1"]);

    history = undo(history);
    expect(history.doc.layers.map((layer) => layer.id)).toEqual(["arrow-1"]);

    history = undo(history);
    expect(history.doc.layers).toEqual([]);
    expect(canUndo(history)).toBe(false);
  });

  it("undoes a crop and keeps annotations", () => {
    let history = createHistory(addLayer(createDocument(image), arrow));
    history = commit(history, setCrop(history.doc, { x: 20, y: 10, width: 80, height: 60 }));

    expect(history.doc.crop).toEqual({ x: 20, y: 10, width: 80, height: 60 });
    history = undo(history);
    expect(history.doc.crop).toEqual({ x: 0, y: 0, width: 200, height: 100 });
    expect(history.doc.layers).toHaveLength(1);
  });

  it("does not grow the past stack when committing the same document", () => {
    const history = createHistory(createDocument(image));
    expect(commit(history, history.doc)).toBe(history);
  });
});
