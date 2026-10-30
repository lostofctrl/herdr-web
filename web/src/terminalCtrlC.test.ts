/** @vitest-environment jsdom */
import { readFile } from "node:fs/promises";
import { Ghostty, InputHandler } from "ghostty-web";
import { describe, expect, it, vi } from "vitest";
import { applyEncoderKittyFlags, handleTerminalCustomKeyEvent } from "./terminalRenderer";

describe("terminal Ctrl+C", () => {
  it.each([0, 1, 2, 3, 7, 8, 10])("sends Ctrl+C through Ghostty with Kitty flags %i", async (flags) => {
    const wasm = await readFile("node_modules/ghostty-web/ghostty-vt.wasm");
    const { instance } = await WebAssembly.instantiate(wasm, { env: { log: () => {} } });
    const ghostty = new Ghostty(instance);
    const container = document.createElement("div");
    const onData = vi.fn();
    const terminal = { getSelection: () => "", input: (data: string) => onData(data) };
    const handler = new InputHandler(ghostty, container, onData, () => {}, undefined,
      (event) => handleTerminalCustomKeyEvent(event, terminal, "Linux x86_64", flags));
    applyEncoderKittyFlags({ inputHandler: handler }, flags);
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(onData).toHaveBeenCalledOnce();
    expect(onData).toHaveBeenCalledWith(flags & 9 ? "\x1b[99;5u" : "\x03");
    onData.mockClear();
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true, repeat: true, bubbles: true, cancelable: true }));
    expect(onData).toHaveBeenCalledOnce();
    expect(onData).toHaveBeenCalledWith(flags & 9 ? `\x1b[99;5${flags & 2 ? ":2" : ""}u` : "\x03");
    handler.dispose();
  });

  it("uses current Kitty flags while preserving selection copy and composition", async () => {
    const wasm = await readFile("node_modules/ghostty-web/ghostty-vt.wasm");
    const { instance } = await WebAssembly.instantiate(wasm, { env: { log: () => {} } });
    const container = document.createElement("div");
    const onData = vi.fn();
    let selection = "";
    let flags = 0;
    const terminal = { getSelection: () => selection, input: (data: string) => onData(data) };
    const handler = new InputHandler(new Ghostty(instance), container, onData, () => {}, undefined,
      (event) => handleTerminalCustomKeyEvent(event, terminal, "Linux x86_64", flags));
    const press = (options: KeyboardEventInit = {}) => container.dispatchEvent(new KeyboardEvent("keydown", {
      key: "c", code: "KeyC", ctrlKey: true, bubbles: true, cancelable: true, ...options,
    }));
    press();
    expect(onData).toHaveBeenLastCalledWith("\x03");
    flags = 1;
    applyEncoderKittyFlags({ inputHandler: handler }, flags);
    press();
    expect(onData).toHaveBeenLastCalledWith("\x1b[99;5u");
    onData.mockClear();
    selection = "selected";
    press();
    selection = "";
    press({ isComposing: true });
    expect(onData).not.toHaveBeenCalled();
    handler.dispose();
  });
});
