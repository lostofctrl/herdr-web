/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { installTerminalMouse } from "./terminalMouse";

afterEach(() => { document.body.innerHTML = ""; });

describe("terminal mouse reporting", () => {
  it("preserves selection when disabled and reports a focused click when enabled", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    let enabled = false;
    const send = vi.fn();
    const focus = vi.fn();
    const dispose = installTerminalMouse(host, () => enabled, () => ({ column: 4, row: 2 }), focus, send);
    const click = () => new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    const normal = click();
    host.dispatchEvent(normal);
    expect(normal.defaultPrevented).toBe(false);
    expect(send).not.toHaveBeenCalled();
    enabled = true;
    const down = click();
    host.dispatchEvent(down);
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    expect(down.defaultPrevented).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
    expect(send.mock.calls.map(([event]) => event)).toEqual([
      { type: "mouse", kind: "down", button: "left", column: 4, row: 2, modifiers: 0, lines: 1 },
      { type: "mouse", kind: "up", button: "left", column: 4, row: 2, modifiers: 0, lines: 1 },
    ]);
    dispose.dispose();
  });

  it("leaves a Ctrl-click on a link to the browser while mouse reporting is enabled", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const send = vi.fn();
    const handler = installTerminalMouse(host, () => true, () => ({ column: 1, row: 1 }), () => {}, send,
      undefined, (event) => event.ctrlKey && event.button === 0);
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
    const up = new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
    host.dispatchEvent(down);
    host.dispatchEvent(up);
    expect([down.defaultPrevented, up.defaultPrevented]).toEqual([false, false]);
    expect(send).not.toHaveBeenCalled();
    handler.dispose();
  });

  it("leaves a Shift-drag to terminal selection while mouse reporting is enabled", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const send = vi.fn();
    const handler = installTerminalMouse(host, () => true, () => ({ column: 1, row: 1 }), () => {}, send);
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true });
    const move = new MouseEvent("mousemove", { bubbles: true, cancelable: true, buttons: 1, shiftKey: false });
    const up = new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 });
    host.dispatchEvent(down);
    host.dispatchEvent(move);
    host.dispatchEvent(up);
    expect([down.defaultPrevented, move.defaultPrevented, up.defaultPrevented]).toEqual([false, false, false]);
    expect(send).not.toHaveBeenCalled();
    handler.dispose();
  });

  it("deduplicates same-cell movement and ignores events outside the host", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const send = vi.fn();
    const handler = installTerminalMouse(host, () => true, () => ({ column: 1, row: 1 }), () => {}, send);
    window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    host.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    host.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    expect(send).toHaveBeenCalledTimes(1);
    handler.dispose();
  });

  it("reports modifiers, movement and wheel without leaving a pressed button on blur", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const send = vi.fn();
    const dispose = installTerminalMouse(host, () => true, () => ({ column: 0, row: 0 }), () => {}, send);
    host.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 2, ctrlKey: true, altKey: true, metaKey: true }));
    window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 2, ctrlKey: true }));
    window.dispatchEvent(new Event("blur"));
    host.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 }));
    expect(send.mock.calls.map(([event]) => [event.kind, event.button, event.modifiers])).toEqual([
      ["down", "right", 14], ["drag", "right", 2], ["up", "right", 2], ["scroll_down", undefined, 0],
    ]);
    dispose.dispose();
  });
});
