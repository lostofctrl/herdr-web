/**
 * The Pi Pane's bottom control stack is the Key Bar stacked on the Composer.
 * The overlays that sit above that stack (Reader launcher, selection sheet,
 * upload status) position themselves from one reported height, so a single
 * part's height is not enough: the value has to cover everything below them.
 */
export function piControlsStackHeight(
  keyBarHeight: number | null,
  composerHeight: number | null,
): number | null {
  const parts = [keyBarHeight, composerHeight].filter(
    (height): height is number => height !== null,
  );
  if (parts.length === 0) {
    return null;
  }
  return parts.reduce((total, height) => total + height, 0);
}
