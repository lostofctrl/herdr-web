/** @vitest-environment jsdom */
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PiComposer } from "./PiComposer";

/**
 * The app renders under <StrictMode>, which mounts, unmounts and remounts every
 * component. A mount flag that the cleanup clears and the effect body never
 * restores makes every async handler return early: the Screenshot Editor never
 * opens and a send stays stuck in `sending` with no error. These tests mount the
 * Composer under StrictMode on purpose.
 */

const editor = vi.hoisted(() => ({
  render: vi.fn(),
}));

vi.mock("../pi/screenshot", () => ({
  ScreenshotEditor: ({ image, onCancel }: { image: { src: string }; onCancel: () => void }) => (
    <div role="dialog" aria-label="Screenshot Editor" data-src={image.src}>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </div>
  ),
  ...editor,
}));

vi.mock("../pi/PiBridgeContext", () => ({
  usePiBridge: () => null,
}));

const roots: Root[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.assign(URL, {
    createObjectURL: vi.fn(() => "blob:pi-mode-strict"),
    revokeObjectURL: vi.fn(),
  });
  // loadNaturalSize() awaits an Image load; jsdom does not decode.
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 40;
      naturalHeight = 20;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderUnderStrictMode(props: Partial<Parameters<typeof PiComposer>[0]> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const onSend = vi.fn(
    (parts: string[], onDelivered: (deliveredParts: number, totalParts: number) => void) => {
      onDelivered(parts.length, parts.length);
      return true;
    },
  );
  const onUploadImages = vi.fn(async () => [{ name: "shot.png", path: "/tmp/uploads/shot.png", size: 1 }]);
  await act(async () => {
    root.render(
      <StrictMode>
        <PiComposer
          bridgeId="bridge-1"
          paneId="pane-a"
          mobile
          active
          disabled={false}
          onSend={onSend}
          onUploadImages={onUploadImages}
          onTerminalFocus={() => {}}
          onControlsHeightChange={() => {}}
          {...props}
        />
      </StrictMode>,
    );
  });
  return { container, onSend, onUploadImages };
}

function promptField(container: HTMLElement) {
  const field = container.querySelector<HTMLTextAreaElement>('[aria-label="Pi prompt"]');
  if (!field) {
    throw new Error("Missing Pi Composer field");
  }
  return field;
}

async function attachImage(container: HTMLElement) {
  const field = promptField(container);
  const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
  // jsdom has no DataTransfer, so the clipboard payload is a minimal stand-in.
  const clipboardData = {
    items: [{ kind: "file", getAsFile: () => file }],
    files: [file],
  };
  await act(async () => {
    // jsdom has no ClipboardEvent either; a bubbling Event with clipboardData
    // is what the Composer's onPaste handler reads.
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.assign(event, { clipboardData });
    field.dispatchEvent(event);
  });
}

describe("PiComposer under StrictMode", () => {
  it("names the closed Composer's open button by its visible text", async () => {
    const { container } = await renderUnderStrictMode({ mobile: false });
    const open = container.querySelector<HTMLButtonElement>("button.pi-composer-open");
    expect(open).not.toBeNull();
    expect(open?.getAttribute("aria-label")?.toLowerCase()).toContain(
      (open?.textContent ?? "").trim().toLowerCase(),
    );
    expect((open?.textContent ?? "").trim()).not.toBe("");
  });

  it("keeps every visible action label inside its accessible name", async () => {
    const { container } = await renderUnderStrictMode();
    const labels = [...container.querySelectorAll<HTMLElement>(".pi-composer-action-label")];
    expect(labels.map((label) => label.textContent)).toEqual(["Slash", "File"]);
    for (const label of labels) {
      const name = label.closest("button")?.getAttribute("aria-label") ?? "";
      expect(name.toLowerCase(), label.textContent ?? "").toContain((label.textContent ?? "").toLowerCase());
    }
    for (const button of container.querySelectorAll<HTMLButtonElement>("button.pi-composer-send, button.pi-composer-close")) {
      const visible = (button.textContent ?? "").trim().toLowerCase();
      expect(visible).not.toBe("");
      expect(button.getAttribute("aria-label")?.toLowerCase()).toContain(visible);
    }
  });

  it("names the desktop Close button by its visible Esc text", async () => {
    const { container } = await renderUnderStrictMode({ mobile: false });
    await act(async () => container.querySelector<HTMLButtonElement>("button.pi-composer-open")?.click());
    const close = container.querySelector<HTMLButtonElement>("button.pi-composer-close");
    expect(close).not.toBeNull();
    const visible = (close?.textContent ?? "").trim().toLowerCase();
    expect(visible).toBe("esc");
    expect(close?.getAttribute("aria-label")?.toLowerCase()).toContain(visible);
  });

  it("opens the Screenshot Editor from an Attachment Chip", async () => {
    const { container } = await renderUnderStrictMode();
    await attachImage(container);

    const chip = container.querySelector<HTMLButtonElement>('button[aria-label="Edit shot.png"]');
    expect(chip).not.toBeNull();
    await act(async () => chip?.click());
    await act(async () => {
      await Promise.resolve();
    });

    // Exactly one editor: a duplicated mount would stack two dialogs and make
    // Cancel close only one of them.
    expect(
      container.querySelectorAll('[role="dialog"][aria-label="Screenshot Editor"]'),
    ).toHaveLength(1);
  });

  it("finishes sending an attachment instead of staying in sending", async () => {
    const { container, onSend, onUploadImages } = await renderUnderStrictMode();
    const field = promptField(container);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(field, "what is wrong?");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await attachImage(container);

    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send prompt"]');
    await act(async () => send?.click());
    await act(async () => {
      await Promise.resolve();
    });

    expect(onUploadImages).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith(
      ["\x1b[200~/tmp/uploads/shot.png what is wrong?\x1b[201~", "\r"],
      expect.any(Function),
    );
    // A finished send clears the chips and re-enables the button.
    expect(container.querySelectorAll('[data-pi-attachment="chip"]')).toHaveLength(0);
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Send prompt"]')?.disabled,
    ).toBe(true);
  });
});
