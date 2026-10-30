import { useLayoutEffect, useState } from "react";

type VisibleViewport = Pick<VisualViewport, "width" | "height" | "offsetLeft" | "offsetTop">;

/** Visible client coordinates, including keyboard shrink and viewport panning. */
export function piComposerViewport(viewport: VisibleViewport | null, width: number, height: number) {
  return viewport
    ? { left: viewport.offsetLeft, top: viewport.offsetTop, width: viewport.width, height: viewport.height }
    : { left: 0, top: 0, width, height };
}

export function usePiComposerViewport(enabled: boolean) {
  const read = () => piComposerViewport(window.visualViewport, window.innerWidth, window.innerHeight);
  const [bounds, setBounds] = useState(read);
  useLayoutEffect(() => {
    if (!enabled) return;
    const refit = () => setBounds(read());
    refit();
    const viewport = window.visualViewport;
    window.addEventListener("resize", refit);
    window.addEventListener("pageshow", refit);
    document.addEventListener("visibilitychange", refit);
    // Some mobile browsers skip the viewport event when the keyboard closes,
    // leaving a stale offset that blanks the top of the expanded Composer.
    let settle: number | undefined;
    const refitAfterBlur = () => {
      window.clearTimeout(settle);
      settle = window.setTimeout(refit, 250);
    };
    document.addEventListener("focusout", refitAfterBlur);
    viewport?.addEventListener("resize", refit);
    viewport?.addEventListener("scroll", refit);
    return () => {
      window.removeEventListener("resize", refit);
      window.removeEventListener("pageshow", refit);
      document.removeEventListener("visibilitychange", refit);
      document.removeEventListener("focusout", refitAfterBlur);
      window.clearTimeout(settle);
      viewport?.removeEventListener("resize", refit);
      viewport?.removeEventListener("scroll", refit);
    };
  }, [enabled]);
  return bounds;
}
