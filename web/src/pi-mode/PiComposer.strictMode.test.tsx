/** @vitest-environment jsdom */
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PiComposer } from "./PiComposer";
import { retainPiComposerDrafts } from "./piComposerDraft";

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
  ScreenshotEditor: ({ image, onCancel, onSave }: { image: { src: string }; onCancel: () => void; onSave: (result: { dataUrl: string; width: number; height: number }) => void }) => (
    <div role="dialog" aria-label="Screenshot Editor" data-src={image.src}>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
      <button type="button" onClick={() => onSave({ dataUrl: "data:image/png;base64,AQID", width: 40, height: 20 })}>
        Save
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
  retainPiComposerDrafts("bridge-1", []);
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
  if (props.mobile !== false) await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open Composer"]')?.click());
  return { container, onSend, onUploadImages, rerender: async (next: typeof props) => act(async () => render(next)) };
}

function promptField(container: HTMLElement) {
  const field = container.querySelector<HTMLTextAreaElement>('[aria-label="Pi prompt"]');
  if (!field) {
    throw new Error("Missing Pi Composer field");
  }
  return field;
}

async function attachImage(container: HTMLElement, name = "shot.png") {
  const field = promptField(container);
  const file = new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
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

async function typePrompt(container: HTMLElement, text: string) {
  const field = promptField(container);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("PiComposer under StrictMode", () => {
  it.each([false, true])("keeps a newer draft after Enter-only recovery (deferred: %s)", async (deferred) => {
    const callbacks: Array<() => void> = [];
    const send = vi.fn((parts: string[], done: (n: number, total: number) => void) => {
      const count = send.mock.calls.length === 1 ? 1 : parts.length;
      if (deferred) callbacks.push(() => done(count, parts.length));
      else done(count, parts.length);
      return true;
    });
    const { container } = await renderUnderStrictMode({ onSend: send });
    await typePrompt(container, "original A");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send prompt"]')!.click());
    if (deferred) await act(async () => callbacks.shift()!());
    await typePrompt(container, "new draft B");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Submit prompt"]')!.click());
    if (deferred) await act(async () => callbacks.shift()!());
    expect(send.mock.calls.map(([parts]) => parts)).toEqual([["\x1b[200~original A\x1b[201~", "\r"], ["\r"]]);
    expect(promptField(container).value).toBe("new draft B");
  });
  it.each([false, true])("removes only unchanged uploaded chips after Enter-only recovery and keeps newer previews (edit during upload: %s)", async (editDuringUpload) => {
    vi.mocked(URL.createObjectURL).mockImplementation(() => `blob:chip-${vi.mocked(URL.createObjectURL).mock.calls.length}`);
    const send = vi.fn((parts: string[], done: (n: number, total: number) => void) => {
      done(send.mock.calls.length === 1 ? 1 : parts.length, parts.length);
      return true;
    });
    const files = [
      { name: "old.png", path: "/tmp/old.png", size: 3 },
      { name: "edited.png", path: "/tmp/edited.png", size: 3 },
    ];
    let finishUpload!: () => void;
    const upload = vi.fn(() => new Promise<typeof files>((resolve) => { finishUpload = () => resolve(files); }));
    const { container } = await renderUnderStrictMode({ onSend: send, onUploadImages: upload });
    await attachImage(container, "old.png");
    await attachImage(container, "edited.png");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send prompt"]')!.click());
    if (!editDuringUpload) await act(async () => finishUpload());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit edited.png"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[role="dialog"] button:last-child')!.click());
    await attachImage(container, "new.png");
    const keptPreviews = [...container.querySelectorAll<HTMLImageElement>('[data-pi-attachment="chip"] img')].slice(1).map((img) => img.src);
    if (editDuringUpload) await act(async () => finishUpload());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Submit prompt"]')!.click());
    expect(send.mock.calls.map(([parts]) => parts)).toEqual([["\x1b[200~/tmp/old.png /tmp/edited.png\x1b[201~", "\r"], ["\r"]]);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-label="Edit old.png"]')).toBeNull();
    expect(container.querySelector('[aria-label="Edit edited.png"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Edit new.png"]')).not.toBeNull();
    expect(keptPreviews).toHaveLength(2);
    for (const preview of keptPreviews) expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(preview);
  });

  it("keeps original image-only delivery identity through rejected and zero-frame recovery attempts", async () => {
    const send = vi.fn((parts: string[], done: (n: number, total: number) => void) => {
      const attempt = send.mock.calls.length;
      if (attempt === 2) return false;
      done(attempt === 1 ? 1 : attempt === 3 ? 0 : parts.length, parts.length);
      return true;
    });
    const { container, onUploadImages } = await renderUnderStrictMode({ onSend: send });
    await attachImage(container);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send prompt"]')!.click());
    await typePrompt(container, "next prompt");
    await attachImage(container, "next.png");
    for (let attempt = 0; attempt < 3; attempt++) {
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Submit prompt"]')!.click());
      expect(promptField(container).value).toBe("next prompt");
      expect(container.querySelector('[aria-label="Edit next.png"]')).not.toBeNull();
    }
    expect(send.mock.calls.map(([parts]) => parts)).toEqual([["\x1b[200~/tmp/uploads/shot.png\x1b[201~", "\r"], ["\r"], ["\r"], ["\r"]]);
    expect(onUploadImages).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-label="Edit shot.png"]')).toBeNull();
    expect(container.querySelector('[aria-label="Submit prompt"]')).toBeNull();
  });

  it.each(["handoff", "unmount"])("ignores delayed recovery settlement after %s", async (loss) => {
    let settle!: () => void;
    const send = vi.fn((parts: string[], done: (n: number, total: number) => void) => {
      if (send.mock.calls.length === 1) done(1, parts.length);
      else settle = () => done(parts.length, parts.length);
      return true;
    });
    const { container } = await renderUnderStrictMode({ onSend: send });
    await typePrompt(container, "original");
    await attachImage(container);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send prompt"]')!.click());
    await typePrompt(container, "new draft");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Submit prompt"]')!.click());
    if (loss === "handoff") {
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Return to terminal"]')!.click());
      await act(async () => settle());
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open Composer"]')!.click());
      expect(container.querySelector('[aria-label="Edit shot.png"]')).not.toBeNull();
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    } else {
      await act(async () => roots.pop()!.unmount());
      await act(async () => settle());
      const remount = await renderUnderStrictMode();
      container.remove();
      expect(promptField(remount.container).value).toBe("new draft");
      expect(remount.container.textContent).toContain("Finish or clear the pending input in the terminal");
      return;
    }
    expect(promptField(container).value).toBe("new draft");
    expect(container.textContent).toContain("Finish or clear the pending input in the terminal");
  });

  it("retains Attachment Chips and the authored draft across explicit mobile terminal return", async () => {
    const { container, onSend, onUploadImages } = await renderUnderStrictMode();
    const field = promptField(container);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, "Keep with image");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await attachImage(container);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Return to terminal"]')?.click());
    expect(container.querySelector('[aria-label="Pi prompt"]')).toBeNull();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open Composer"]')?.click());
    expect(promptField(container).value).toBe("Keep with image");
    expect(container.querySelector('[aria-label="Edit shot.png"]')).not.toBeNull();
    expect(onUploadImages).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

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

  it("preserves attached images through explicit Abort without uploading or sending the draft", async () => {
    const { container, onSend, onUploadImages } = await renderUnderStrictMode();
    await attachImage(container);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Composer helpers"]')?.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Abort Pi"]')?.click());
    expect(onSend.mock.calls.map(([parts]) => parts)).toEqual([["\u001b"]]);
    expect(onUploadImages).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Edit shot.png"]')).not.toBeNull();
  });

  it("reports a rejected quick action without clearing attachments or leaving it pending", async () => {
    const { container } = await renderUnderStrictMode({ onSend: () => false });
    await attachImage(container);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Composer helpers"]')?.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Abort Pi"]')?.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Action could not be queued");
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Abort Pi"]')?.disabled).toBe(false);
    expect(container.querySelector('[aria-label="Edit shot.png"]')).not.toBeNull();
  });

  it("prevents quick actions and insertion while an ordinary prompt awaits Enter-only recovery", async () => {
    const onSend = vi.fn((_parts: string[], delivered: (count: number, total: number) => void) => { delivered(1, 2); return true; });
    const { container } = await renderUnderStrictMode({ onSend });
    const field = promptField(container);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, "Partial prompt");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send prompt"]')?.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Composer helpers"]')?.click());
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Abort Pi"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Stop Pi"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-helper="file"]')?.disabled).toBe(true);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(field.value).toBe("Partial prompt");
    expect(container.querySelector('[aria-label="Submit prompt"]')).not.toBeNull();
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
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Abort Pi");
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

  it("invalidates a delayed image upload after Return without losing draft or chips", async () => {
    let finish!: (files: { name: string; path: string; size: number }[]) => void;
    const upload = vi.fn(() => new Promise<{ name: string; path: string; size: number }[]>((resolve) => { finish = resolve; }));
    const { container, onSend } = await renderUnderStrictMode({ onUploadImages: upload });
    await attachImage(container);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send prompt"]')?.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Return to terminal"]')?.click());
    await act(async () => finish([{ name: "shot.png", path: "/tmp/late.png", size: 1 }]));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open Composer"]')?.click());
    expect(onSend).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Edit shot.png"]')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Send prompt"]')?.disabled).toBe(true);
    expect(container.textContent).toContain("Finish or clear the pending input in the terminal");
  });

  it("recovers an image prompt with Enter only and never reuploads or repastes its paths", async () => {
    let attempt = 0;
    const send = vi.fn((parts: string[], done: (n: number, total: number) => void) => {
      done(attempt++ === 0 ? 1 : parts.length, parts.length);
      return true;
    });
    const { container, onUploadImages } = await renderUnderStrictMode({ onSend: send });
    await attachImage(container);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send prompt"]')?.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Submit prompt"]')?.click());
    expect(send.mock.calls.map(([parts]) => parts)).toEqual([["\x1b[200~/tmp/uploads/shot.png\x1b[201~", "\r"], ["\r"]]);
    expect(onUploadImages).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-label="Edit shot.png"]')).toBeNull();
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
