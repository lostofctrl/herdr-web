type BackgroundRenderer = {
  ctx: CanvasRenderingContext2D;
  renderLine: (...args: never[]) => void;
};

// ghostty-web paints each cell separately; fractional device pixels leave seams.
export function installTerminalBackgroundPixelAlignment(renderer: unknown) {
  const target = renderer as BackgroundRenderer | null;
  if (!target || typeof target.renderLine !== "function" || !target.ctx) return;

  const renderLine = target.renderLine;
  target.renderLine = function (...args: never[]) {
    const ctx = target.ctx;
    const fillRect = ctx.fillRect;
    const transform = ctx.getTransform();
    const { a: scaleX, d: scaleY, e: offsetX, f: offsetY } = transform;
    if (!scaleX || !scaleY || transform.b || transform.c) {
      return renderLine.apply(target, args);
    }
    const snapX = (x: number) => (Math.round(x * scaleX + offsetX) - offsetX) / scaleX;
    const snapY = (y: number) => (Math.round(y * scaleY + offsetY) - offsetY) / scaleY;
    ctx.fillRect = (x, y, width, height) => {
      const left = snapX(x);
      const top = snapY(y);
      fillRect.call(ctx, left, top, snapX(x + width) - left, snapY(y + height) - top);
    };
    try {
      return renderLine.apply(target, args);
    } finally {
      ctx.fillRect = fillRect;
    }
  };
}
