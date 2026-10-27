/**
 * @vitest-environment jsdom
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ScreenshotEditor } from "./ScreenshotEditor";
import type {
  ScreenshotEditorSurface,
  ScreenshotImage,
  ScreenshotSaveResult,
} from "./ScreenshotEditor";
import type { PngExportPlan } from "./export";
import type { Layer, ScreenshotDocument } from "./model";

const image: ScreenshotImage = { src: "data:image/png;base64,AAAA", width: 200, height: 100 };

const roots: Root[] = [];
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  container = document.createElement("div");
  document.body.append(container);
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 200,
    bottom: 100,
    width: 200,
    height: 100,
    toJSON: () => ({}),
  });
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function createSurface() {
  const rendered: ScreenshotDocument[] = [];
  const surface: ScreenshotEditorSurface & {
    rendered: ScreenshotDocument[];
    exportPng: ReturnType<typeof vi.fn>;
  } = {
    rendered,
    render: (doc) => {
      rendered.push(doc);
    },
    exportPng: vi.fn((doc: ScreenshotDocument): ScreenshotSaveResult => {
      const plan: PngExportPlan = {
        mimeType: "image/png" as const,
        width: doc.crop.width,
        height: doc.crop.height,
        crop: doc.crop,
        layers: doc.layers,
      };
      return {
        dataUrl: "data:image/png;base64,SAVED",
        width: plan.width,
        height: plan.height,
        plan,
        document: doc,
      };
    }),
  };
  return surface;
}

function mount(element: ReactElement) {
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(element);
  });
  return root;
}

function button(name: string | RegExp): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find((candidate) =>
    typeof name === "string" ? candidate.textContent?.trim() === name : name.test(candidate.textContent ?? ""),
  );
  if (!match) {
    throw new Error(`button ${String(name)} not found`);
  }
  return match;
}

function canvas(): HTMLCanvasElement {
  const element = container.querySelector("canvas");
  if (!element) {
    throw new Error("canvas not found");
  }
  return element;
}

function drag(from: { x: number; y: number }, to: { x: number; y: number }) {
  const target = canvas();
  act(() => {
    target.dispatchEvent(pointer("pointerdown", from));
  });
  act(() => {
    target.dispatchEvent(pointer("pointermove", to));
  });
  act(() => {
    target.dispatchEvent(pointer("pointerup", to));
  });
}

function pointer(type: string, point: { x: number; y: number }) {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: point.x,
    clientY: point.y,
    pointerId: 1,
    isPrimary: true,
    button: 0,
  });
}

function tap(point: { x: number; y: number }) {
  const target = canvas();
  act(() => {
    target.dispatchEvent(pointer("pointerdown", point));
  });
  act(() => {
    target.dispatchEvent(pointer("pointerup", point));
  });
}

function savedLayers(result: ScreenshotSaveResult): readonly Layer[] {
  return result.plan.layers;
}

describe("ScreenshotEditor save and cancel semantics", () => {
  it("calls onSave with the exported PNG and edits only when Save is tapped", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const surface = createSurface();
    mount(<ScreenshotEditor image={image} onSave={onSave} onCancel={onCancel} surface={surface} />);

    drag({ x: 10, y: 10 }, { x: 60, y: 60 });
    expect(onSave).not.toHaveBeenCalled();

    act(() => {
      button("Save").click();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    const result = onSave.mock.calls[0]?.[0] as ScreenshotSaveResult;
    expect(result.dataUrl).toBe("data:image/png;base64,SAVED");
    expect(result.plan.mimeType).toBe("image/png");
    expect(savedLayers(result)).toHaveLength(1);
  });

  it("calls onCancel and never exports, even after edits", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const surface = createSurface();
    mount(<ScreenshotEditor image={image} onSave={onSave} onCancel={onCancel} surface={surface} />);

    drag({ x: 5, y: 5 }, { x: 40, y: 40 });
    act(() => {
      button("Cancel").click();
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    expect(surface.exportPng).not.toHaveBeenCalled();
  });
});

describe("ScreenshotEditor tools", () => {
  function mountEditor() {
    const onSave = vi.fn();
    const surface = createSurface();
    mount(<ScreenshotEditor image={image} onSave={onSave} onCancel={vi.fn()} surface={surface} />);
    return { onSave, surface };
  }

  it("draws an arrow and saves it with the selected stroke width", () => {
    const { onSave } = mountEditor();
    act(() => {
      button("Arrow").click();
      button("Stroke 8 px").click();
    });
    drag({ x: 10, y: 20 }, { x: 90, y: 70 });
    act(() => {
      button("Save").click();
    });

    const [layer] = savedLayers(onSave.mock.calls[0]?.[0] as ScreenshotSaveResult);
    expect(layer).toMatchObject({
      kind: "arrow",
      strokeWidth: 8,
      from: { x: 10, y: 20 },
      to: { x: 90, y: 70 },
    });
  });

  it("draws a circle from a drag", () => {
    const { onSave } = mountEditor();
    act(() => {
      button("Circle").click();
    });
    drag({ x: 100, y: 40 }, { x: 120, y: 60 });
    act(() => {
      button("Save").click();
    });

    const [layer] = savedLayers(onSave.mock.calls[0]?.[0] as ScreenshotSaveResult);
    expect(layer).toMatchObject({ kind: "circle", center: { x: 110, y: 50 } });
    expect(layer).toHaveProperty("radius", expect.closeTo(Math.hypot(10, 10)));
  });

  it("adds text at the tapped point", () => {
    const { onSave } = mountEditor();
    act(() => {
      button("Text").click();
    });
    tap({ x: 30, y: 40 });

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Annotation text"]');
    expect(input).not.toBeNull();
    act(() => {
      if (input) {
        const setValue = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        setValue?.call(input, "look here");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    act(() => {
      button("Add text").click();
    });
    act(() => {
      button("Save").click();
    });

    const [layer] = savedLayers(onSave.mock.calls[0]?.[0] as ScreenshotSaveResult);
    expect(layer).toMatchObject({ kind: "text", text: "look here", at: { x: 30, y: 40 } });
    expect(container.querySelector('input[aria-label="Annotation text"]')).toBeNull();
  });

  it("adds a redaction box that lands last in the export plan", () => {
    const { onSave } = mountEditor();
    act(() => {
      button("Arrow").click();
    });
    drag({ x: 0, y: 0 }, { x: 30, y: 30 });
    act(() => {
      button("Redact").click();
    });
    drag({ x: 50, y: 20 }, { x: 90, y: 60 });
    act(() => {
      button("Save").click();
    });

    const layers = savedLayers(onSave.mock.calls[0]?.[0] as ScreenshotSaveResult);
    expect(layers.map((layer) => layer.kind)).toEqual(["arrow", "redaction"]);
    expect(layers[1]).toMatchObject({ rect: { x: 50, y: 20, width: 40, height: 40 } });
  });

  it("undoes the last edit only", () => {
    const { onSave } = mountEditor();
    act(() => {
      button("Circle").click();
    });
    drag({ x: 10, y: 10 }, { x: 30, y: 30 });
    drag({ x: 60, y: 10 }, { x: 80, y: 30 });
    act(() => {
      button("Undo").click();
    });
    act(() => {
      button("Save").click();
    });

    const layers = savedLayers(onSave.mock.calls[0]?.[0] as ScreenshotSaveResult);
    expect(layers).toHaveLength(1);
    expect(layers[0]).toMatchObject({ kind: "circle", center: { x: 20, y: 20 } });
  });

  it("crops the exported image and undoes the crop", () => {
    const { onSave } = mountEditor();
    act(() => {
      button("Crop").click();
    });
    drag({ x: 20, y: 10 }, { x: 120, y: 60 });
    act(() => {
      button("Apply crop").click();
    });
    act(() => {
      button("Save").click();
    });

    const result = onSave.mock.calls[0]?.[0] as ScreenshotSaveResult;
    expect(result.width).toBe(100);
    expect(result.height).toBe(50);
    expect(result.plan.crop).toEqual({ x: 20, y: 10, width: 100, height: 50 });

    act(() => {
      button("Undo").click();
    });
    act(() => {
      button("Save").click();
    });
    const undoResult = onSave.mock.calls[1]?.[0] as ScreenshotSaveResult;
    expect(undoResult.width).toBe(200);
    expect(undoResult.height).toBe(100);
  });

  it("re-renders the surface for every document change", () => {
    const { surface } = mountEditor();
    expect(surface.rendered.length).toBeGreaterThanOrEqual(1);
    const before = surface.rendered.length;
    act(() => {
      button("Stroke 2 px").click();
    });
    expect(surface.rendered.length).toBeGreaterThan(before);
    expect(surface.rendered.at(-1)?.strokeWidth).toBe(2);
  });
});
