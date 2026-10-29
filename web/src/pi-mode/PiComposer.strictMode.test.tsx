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
  window.localStorage.clear();
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
  const render = (next = props) => root.render(
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
          {...next}
        />
      </StrictMode>,
    );
  await act(async () => render());
  return { container, onSend, onUploadImages, rerender: async (next: typeof props) => act(async () => render(next)) };
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
  it("opens one mobile authoring menu and inserts a shell prefix without submitting", async () => {
    const { container, onSend } = await renderUnderStrictMode();
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Composer helpers"]');
    expect(trigger).not.toBeNull();
    await act(async () => trigger?.click());
    const menu = container.querySelector('[role="menu"][aria-label="Composer helpers"]');
    expect(menu).not.toBeNull();
    const shell = menu?.querySelector<HTMLButtonElement>('[role="menuitem"][data-helper="shell"]');
    expect(shell).not.toBeNull();
    await act(async () => shell?.click());
    expect(promptField(container).value).toBe("!");
    expect(promptField(container).selectionStart).toBe(1);
    expect(document.activeElement).toBe(promptField(container));
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("dismisses helpers on pane deactivation and prevents a stale menu owning focus", async () => {
    const { container, rerender } = await renderUnderStrictMode();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Composer helpers"]')?.click());
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    await rerender({ active: false });
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it("blocks helpers while a terminal delivery is pending and retains the draft", async () => {
    const { container } = await renderUnderStrictMode({ onSend: () => true });
    const field = promptField(container);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, "keep this");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send prompt"]')?.click());
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Composer helpers"]')?.disabled).toBe(true);
    expect(field.value).toBe("keep this");
  });

  it("replaces a selected range with a spaced file trigger while offline", async () => {
    const { container, onSend } = await renderUnderStrictMode();
    const field = promptField(container);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, "hello OLD tail");
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.focus();
      field.setSelectionRange(6, 9);
    });
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Composer helpers"]')?.click());
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Bridge offline");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-helper="file"]')?.click());
    expect(field.value).toBe("hello @ tail");
    expect(field.selectionStart).toBe(7);
    expect(field.selectionEnd).toBe(7);
    expect(document.activeElement).toBe(field);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("navigates the menu, restores trigger focus on Escape and consumes outside clicks", async () => {
    const { container } = await renderUnderStrictMode();
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Composer helpers"]')!;
    await act(async () => trigger.click());
    expect((document.activeElement as HTMLElement).dataset.helper).toBe("slash");
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect((document.activeElement as HTMLElement).dataset.helper).toBe("shell");
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await act(async () => trigger.click());
    const terminalClick = vi.fn();
    const outside = document.createElement("button");
    outside.addEventListener("click", terminalClick);
    document.body.append(outside);
    await act(async () => {
      outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      outside.click();
    });
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(terminalClick).not.toHaveBeenCalled();
  });

  it("renders supplied conversation context only above an open editor", async () => {
    const conversationContext = <aside aria-label="Conversation context">Current exchange</aside>;
    const { container } = await renderUnderStrictMode({ mobile: false, conversationContext });
    expect(container.querySelector('[aria-label="Conversation context"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open Composer"]')?.click());
    const context = container.querySelector('[aria-label="Conversation context"]');
    expect(context).not.toBeNull();
    expect((context?.compareDocumentPosition(promptField(container)) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps disabled terminal helpers unavailable and ignores authoring during IME composition", async () => {
    const { container, rerender, onSend } = await renderUnderStrictMode({ disabled: true });
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Composer helpers"]')?.disabled).toBe(true);
    await rerender({ disabled: false });
    const field = promptField(container);
    await act(async () => field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Composer helpers"]')?.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-helper="shell"]')?.click());
    expect(field.value).toBe("");
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  });

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
    expect(labels.map((label) => label.textContent)).toEqual(["History"]);
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
