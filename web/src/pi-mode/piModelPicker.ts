import type { PiModel } from "../pi/piProtocol";

/** Models are unique by provider+id; ids alone may repeat across providers. */
export function piModelKey(model: { provider: string; id: string }) {
  return JSON.stringify([model.provider, model.id]);
}

/** Case-insensitive AND search over every searchable field. */
export function filterPiModels(models: readonly PiModel[], query: string) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...models];
  return models.filter((model) => {
    const haystack = `${model.label} ${model.id} ${model.provider}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** Panel metrics kept in CSS pixels so placement can be unit tested. */
export type PiModelPickerPlacement = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
};

const PANEL_MARGIN = 8;
const PANEL_WIDTH = 22 * 16;
const PANEL_MIN_HEIGHT = 160;
const PANEL_VIEWPORT_SHARE = 0.6;

/**
 * Places the model panel against its trigger while keeping it inside the
 * viewport. The Composer mounts the trigger at the left edge of a one-pane
 * stage whose ancestors hide overflow, and the side panel scrolls, so an
 * absolutely positioned panel is clipped there; fixed metrics derived from the
 * trigger rect cannot be. The panel prefers the space above the trigger and
 * flips below when that space cannot hold a usable list, and its height is
 * capped to the chosen side so it never renders off screen.
 */
export function piModelPickerPlacement(
  trigger: { top: number; bottom: number; left: number },
  viewport: { width: number; height: number },
): PiModelPickerPlacement {
  const width = Math.max(
    0,
    Math.min(PANEL_WIDTH, viewport.width - PANEL_MARGIN * 2),
  );
  const rightmost = Math.max(PANEL_MARGIN, viewport.width - width - PANEL_MARGIN);
  const left = Math.min(Math.max(trigger.left, PANEL_MARGIN), rightmost);
  const share = viewport.height * PANEL_VIEWPORT_SHARE;
  const spaceAbove = Math.max(0, trigger.top - PANEL_MARGIN * 2);
  const spaceBelow = Math.max(0, viewport.height - trigger.bottom - PANEL_MARGIN * 2);
  const above = spaceAbove >= PANEL_MIN_HEIGHT || spaceAbove >= spaceBelow;
  const maxHeight = Math.max(0, Math.min(share, above ? spaceAbove : spaceBelow));
  const top = above
    ? Math.max(PANEL_MARGIN, trigger.top - PANEL_MARGIN - maxHeight)
    : Math.min(viewport.height - PANEL_MARGIN - maxHeight, trigger.bottom + PANEL_MARGIN);
  return { left, top, width, maxHeight };
}
