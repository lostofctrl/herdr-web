export type TerminalMouseButton = "left" | "middle" | "right";
export type TerminalMouseFrame = {
  type: "mouse";
  kind: "down" | "up" | "drag" | "moved" | "scroll_up" | "scroll_down" | "scroll_left" | "scroll_right";
  button?: TerminalMouseButton;
  column: number;
  row: number;
  modifiers: number;
  lines: number;
};

type MousePosition = { column: number; row: number };

/** Capture browser mouse events before Ghostty can emit duplicate terminal bytes. */
export function installTerminalMouse(
  host: HTMLElement,
  enabled: () => boolean,
  position: (x: number, y: number) => MousePosition,
  focus: () => void,
  send: (frame: TerminalMouseFrame) => void,
  wheelLines: (event: WheelEvent) => number = (event) => Math.sign(event.deltaY),
  bypassMouseDown: (event: MouseEvent) => boolean = () => false,
) {
  let pressed: TerminalMouseButton | undefined;
  let selecting = false;
  let lastPosition: MousePosition = { column: 0, row: 0 };
  let lastModifiers = 0;
  let lastMove = "";
  const modifiers = (event: MouseEvent) =>
    (event.shiftKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.altKey ? 4 : 0) | (event.metaKey ? 8 : 0);
  const consume = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const update = (event: MouseEvent) => {
    lastPosition = position(event.clientX, event.clientY);
    lastModifiers = modifiers(event);
  };
  const emit = (kind: TerminalMouseFrame["kind"], button?: TerminalMouseButton, lines = 1) => {
    send({ type: "mouse", kind, ...(button ? { button } : {}), ...lastPosition, modifiers: lastModifiers, lines });
  };
  const release = () => {
    selecting = false;
    if (pressed) {
      emit("up", pressed);
      pressed = undefined;
      lastMove = "";
    }
  };
  const onDown = (event: MouseEvent) => {
    const button = (["left", "middle", "right"] as const)[event.button];
    if (!enabled() || !button) return;
    if (button === "left" && !pressed && (event.shiftKey || bypassMouseDown(event))) {
      selecting = true;
      return;
    }
    consume(event);
    if (pressed) return;
    update(event);
    focus();
    pressed = button;
    lastMove = "";
    emit("down", button);
  };
  const onUp = (event: MouseEvent) => {
    if (selecting && event.button === 0) {
      selecting = false;
      return;
    }
    if (!pressed || (["left", "middle", "right"] as const)[event.button] !== pressed) return;
    update(event);
    consume(event);
    release();
  };
  const onMove = (event: MouseEvent) => {
    if (selecting || !enabled() || (!pressed && (!(event.target instanceof Node) || !host.contains(event.target)))) return;
    update(event);
    consume(event);
    const move = `${pressed ?? ""}:${lastPosition.column}:${lastPosition.row}:${lastModifiers}`;
    if (move === lastMove) return;
    lastMove = move;
    emit(pressed ? "drag" : "moved", pressed);
  };
  const onWheel = (event: WheelEvent) => {
    if (!enabled()) return;
    update(event);
    consume(event);
    const lines = wheelLines(event);
    if (lines !== 0) emit(lines < 0 ? "scroll_up" : "scroll_down", undefined, Math.min(200, Math.abs(lines)));
  };
  const onContextMenu = (event: MouseEvent) => { if (enabled()) consume(event); };
  host.addEventListener("mousedown", onDown, true);
  window.addEventListener("mouseup", onUp, true);
  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("blur", release);
  host.addEventListener("wheel", onWheel, { capture: true, passive: false });
  host.addEventListener("contextmenu", onContextMenu, true);
  return {
    release,
    dispose() {
      release();
      host.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("blur", release);
      host.removeEventListener("wheel", onWheel, true);
      host.removeEventListener("contextmenu", onContextMenu, true);
    },
  };
}
