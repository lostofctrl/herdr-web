import { describe, expect, it, vi } from "vitest";
import {
  applyEncoderKittyFlags,
  handleTerminalCustomKeyEvent,
  textareaKeyboardEventOutput,
  installTerminalInteractionRendering,
  renderGhosttyTerminalFrame,
  refreshTerminalFontRendering,
  shouldUseEventDrivenTerminalRendering,
  suspendGhosttyIdleRenderLoop,
} from "./terminalRenderer";

describe("terminal keyboard protocol handoff", () => {
  it("pushes the negotiated Kitty flags into the ghostty key encoder", () => {
    const setKittyFlags = vi.fn();
    const terminal = { inputHandler: { encoder: { setKittyFlags } } };

    applyEncoderKittyFlags(terminal, 7);
    applyEncoderKittyFlags(terminal, 0);

    expect(setKittyFlags.mock.calls).toEqual([[7], [0]]);
  });

  it("survives terminals without an accessible encoder", () => {
    const throwing = {
      inputHandler: {
        encoder: {
          setKittyFlags: () => {
            throw new Error("wasm disposed");
          },
        },
      },
    };

    expect(() => applyEncoderKittyFlags(null, 7)).not.toThrow();
    expect(() => applyEncoderKittyFlags({}, 7)).not.toThrow();
    expect(() => applyEncoderKittyFlags({ inputHandler: {} }, 7)).not.toThrow();
    expect(() => applyEncoderKittyFlags(throwing, 7)).not.toThrow();
  });
});

describe("terminal event-driven rendering", () => {
  it("redraws idle selections and scrolling and removes the hooks on disposal", () => {
    const originalRequestRender = vi.fn();
    const selectionManager = {
      requestRender: originalRequestRender,
      getSelectionCoords: vi.fn(),
      getDirtySelectionRows: vi.fn(),
    };
    let onScroll: (() => void) | undefined;
    const dispose = vi.fn();
    const terminal = {
      selectionManager,
      onScroll: (callback: () => void) => {
        onScroll = callback;
        return { dispose };
      },
    } as never;
    const redraw = vi.fn();
    const cleanup = installTerminalInteractionRendering(terminal, redraw);
    selectionManager.requestRender();
    onScroll?.();
    expect(redraw).toHaveBeenCalledTimes(2);
    expect(originalRequestRender).not.toHaveBeenCalled();
    cleanup();
    expect(dispose).toHaveBeenCalledOnce();
    expect(selectionManager.requestRender).toBe(originalRequestRender);
  });

  it("only enables the idle-loop workaround for a non-blinking Windows terminal", () => {
    expect(shouldUseEventDrivenTerminalRendering(false, "Win32")).toBe(true);
    expect(shouldUseEventDrivenTerminalRendering(true, "Win32")).toBe(false);
    expect(shouldUseEventDrivenTerminalRendering(false, "MacIntel")).toBe(false);
    expect(shouldUseEventDrivenTerminalRendering(false, "Linux armv8l")).toBe(false);
  });

  it("cancels ghostty-web's pending idle frame", () => {
    const cancelFrame = vi.fn();
    const terminal = { animationFrameId: 42 } as never;

    expect(suspendGhosttyIdleRenderLoop(terminal, cancelFrame)).toBe(true);
    expect(cancelFrame).toHaveBeenCalledWith(42);
    expect(terminal).not.toHaveProperty("animationFrameId");
    expect(suspendGhosttyIdleRenderLoop(terminal, cancelFrame)).toBe(false);
  });

  it("renders the current viewport with ghostty's scrollbar state", () => {
    const renderer = { render: vi.fn() };
    const wasmTerm = {};
    const terminal = {
      renderer,
      wasmTerm,
      viewportY: 8,
      scrollbarOpacity: 0.4,
    } as never;

    expect(renderGhosttyTerminalFrame(terminal)).toBe(true);
    expect(renderer.render).toHaveBeenCalledWith(wasmTerm, false, 8, terminal, 0.4);
  });
});

describe("terminal renderer font refresh", () => {
  it("forces the current viewport to redraw when font settings are unchanged", () => {
    const calls: string[] = [];
    const wasmTerm = {};
    const renderer = {
      remeasureFont: vi.fn(() => calls.push("remeasure")),
      render: vi.fn(() => calls.push("render")),
    };
    const terminal = {
      options: {
        fontFamily: "same font",
        fontSize: 14,
      },
      renderer,
      viewportY: 7,
      wasmTerm,
    } as unknown as Parameters<typeof refreshTerminalFontRendering>[0];
    const fit = vi.fn(() => {
      calls.push("fit");
      return { cols: 120, rows: 40 };
    });

    expect(refreshTerminalFontRendering(terminal, "same font", 14, fit)).toEqual({
      cols: 120,
      rows: 40,
    });
    expect(terminal.options.fontFamily).toBe("same font");
    expect(terminal.options.fontSize).toBe(14);
    expect(renderer.render).toHaveBeenCalledWith(wasmTerm, true, 7, terminal, 0);
    expect(calls).toEqual(["remeasure", "fit", "render"]);
  });
});

describe("terminal textarea shortcuts", () => {
  it("encodes Alt printable keys without swallowing IME, AltGr, or browser modifiers", () => {
    expect(textareaKeyboardEventOutput(keyEvent({ key: "c", altKey: true }))).toBe("\x1bc");
    expect(textareaKeyboardEventOutput(keyEvent({ key: "C", altKey: true, shiftKey: true }))).toBe("\x1bC");
    expect(textareaKeyboardEventOutput(keyEvent({ key: "d", altKey: true }))).toBeNull();
    expect(textareaKeyboardEventOutput(keyEvent({ key: " ", altKey: true }))).toBeNull();
    expect(textareaKeyboardEventOutput(keyEvent({ key: "c", altKey: true, metaKey: true }))).toBeNull();
    expect(textareaKeyboardEventOutput(keyEvent({ key: "c", altKey: true, ctrlKey: true }))).toBeNull();
    expect(textareaKeyboardEventOutput(keyEvent({ key: "c", altKey: true, isComposing: true }))).toBeNull();
    expect(textareaKeyboardEventOutput(keyEvent({ key: "c", altKey: true, getModifierState: (key: string) => key === "AltGraph" }))).toBeNull();
  });

  it("encodes Alt printable keys as CSI u only for the disabling-unambiguity Kitty flags", () => {
    expect(textareaKeyboardEventOutput(keyEvent({ key: "c", altKey: true }), 1)).toBe("\x1b[99;3u");
    expect(textareaKeyboardEventOutput(keyEvent({ key: "C", altKey: true, shiftKey: true }), 8)).toBe("\x1b[67;4u");
    expect(textareaKeyboardEventOutput(keyEvent({ key: "c", altKey: true }), 7)).toBe("\x1b[99;3u");
    expect(textareaKeyboardEventOutput(keyEvent({ key: "c", altKey: true }), 9)).toBe("\x1b[99;3u");
    expect(textareaKeyboardEventOutput(keyEvent({ key: "d", altKey: true }), 1)).toBeNull();
    expect(textareaKeyboardEventOutput(keyEvent({ key: "c", altKey: true }), 0)).toBe("\x1bc");
    expect(textareaKeyboardEventOutput(keyEvent({ key: "c", altKey: true }), 2)).toBe("\x1bc");
    expect(textareaKeyboardEventOutput(keyEvent({ key: "c", altKey: true }), 4)).toBe("\x1bc");
    expect(textareaKeyboardEventOutput(keyEvent({ key: "c", altKey: true }), 6)).toBe("\x1bc");
    expect(textareaKeyboardEventOutput(keyEvent({ key: "c", altKey: true }), 16)).toBe("\x1bc");
  });

  it("encodes Ctrl+Shift printable keys as CSI u so they stay distinct", () => {
    expect(textareaKeyboardEventOutput(keyEvent({ key: "C", ctrlKey: true, shiftKey: true }), 1)).toBe(
      "\x1b[67;6u",
    );
    expect(textareaKeyboardEventOutput(keyEvent({ key: "P", ctrlKey: true, shiftKey: true }), 7)).toBe(
      "\x1b[80;6u",
    );
    expect(textareaKeyboardEventOutput(keyEvent({ key: "i", ctrlKey: true, shiftKey: true }), 1)).toBeNull();
    expect(textareaKeyboardEventOutput(keyEvent({ key: "v", ctrlKey: true, shiftKey: true }), 1)).toBeNull();
    expect(textareaKeyboardEventOutput(keyEvent({ key: "C", ctrlKey: true, shiftKey: true }), 0)).toBeNull();
    expect(
      textareaKeyboardEventOutput(keyEvent({ key: "C", ctrlKey: true, shiftKey: true, altKey: true }), 1),
    ).toBeNull();
  });
});

describe("terminal selection copy shortcuts", () => {
  it("consumes Windows/Linux Ctrl+C when canonical terminal selection text exists", () => {
    const terminal = terminalInput("selected terminal text");

    expect(dispatchCtrlC(keyEvent({ ctrlKey: true }), terminal, "Win32")).toBe(true);
    expect(terminal.getSelection).toHaveBeenCalledOnce();
    expect(terminal.input).not.toHaveBeenCalled();
  });

  it("delegates Windows/Linux Ctrl+C to Ghostty for PTY ^C when selection is empty", () => {
    const terminal = terminalInput("");

    expect(dispatchCtrlC(keyEvent({ ctrlKey: true }), terminal, "Linux x86_64")).toBe(false);
    expect(terminal.input).toHaveBeenCalledOnce();
    expect(terminal.input).toHaveBeenCalledWith("\x03", true);
  });

  it("consumes macOS Cmd+C when canonical terminal selection text exists", () => {
    const terminal = terminalInput("selected terminal text");

    expect(dispatchCtrlC(keyEvent({ metaKey: true }), terminal, "MacIntel")).toBe(true);
    expect(terminal.input).not.toHaveBeenCalled();
  });

  it("delegates macOS Ctrl+C to Ghostty for PTY interrupt even with a selection", () => {
    const terminal = terminalInput("selected terminal text");

    expect(dispatchCtrlC(keyEvent({ ctrlKey: true }), terminal, "MacIntel")).toBe(false);
    expect(terminal.input).toHaveBeenCalledOnce();
    expect(terminal.input).toHaveBeenCalledWith("\x03", true);
  });
});

function keyEvent(overrides: Partial<KeyboardEvent> = {}) {
  return {
    altKey: false,
    code: "KeyC",
    ctrlKey: false,
    isComposing: false,
    getModifierState: () => false,
    key: "c",
    keyCode: 67,
    metaKey: false,
    shiftKey: false,
    stopImmediatePropagation: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent;
}

function terminalInput(selection: string) {
  return {
    getSelection: vi.fn(() => selection),
    input: vi.fn(),
  };
}

function dispatchCtrlC(
  event: KeyboardEvent,
  terminal: ReturnType<typeof terminalInput>,
  platform: string,
) {
  const handled = handleTerminalCustomKeyEvent(event, terminal, platform);
  if (!handled) {
    // This is Ghostty's existing default Ctrl+C encoding path.
    terminal.input("\x03", true);
  }
  return handled;
}
