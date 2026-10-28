# Screenshot Editor

Isolated image annotation surface for Pi mode. It opens from an Attachment Chip
(the Attachment Chips mount it), lets the user crop, redact and annotate with touch or
mouse, and returns one PNG that replaces the chip image.

Everything here is self-contained: no imports from the terminal, the bridge or the
rest of the Pi mode UI.

## Boundary for Attachment Chips

```tsx
import { ScreenshotEditor } from "./pi/screenshot";
import type { ScreenshotSaveResult } from "./pi/screenshot";

<ScreenshotEditor
  image={{ src: chipDataUrl, width: chipWidth, height: chipHeight }}
  onSave={(result: ScreenshotSaveResult) => replaceChipImage(chipId, result.dataUrl)}
  onCancel={() => closeEditor()}
/>;
```

- `onSave` receives the exported PNG (`dataUrl`, output `width`/`height`, the
  `plan` that produced it, and the final `document`). The chip replaces its image;
  the editor does not know about chips.
- `onCancel` receives nothing. The chip keeps the original image.
- `image.width`/`image.height` are the image's natural pixel size. The PNG in
  `result.dataUrl` has the crop size, not necessarily the original size.
- Mount it as an overlay (it renders `position: fixed`); the chip decides when it
  is mounted and unmounted.

## Tools

- Arrow, circle, text, crop and solid redaction.
- Stroke widths 2, 4 and 8 px; text size scales with the stroke width.
- Undo covers layers and applied crops in one history.
- Crop is chosen by dragging and applied with "Apply crop"; the preview always
  shows the current crop.
- Redaction is a solid opaque black box. It is painted after every annotation and
  burned into the exported pixels, so the exported PNG has no recoverable
  original content underneath and no removable redaction layer.
- Export is always `image/png` (`createPngExportPlan`).

## Pure engine and seams

- `geometry.ts`: drag normalisation, crop clamping, circle/arrow geometry,
  client-to-image mapping. No DOM.
- `model.ts`: document, tool/stroke settings, layers, undo history. No DOM.
- `export.ts`: the PNG export decision and plan (crop size, annotations first,
  redactions last and clipped to the crop). No DOM.
- `render.ts`: paints a document into any `Canvas2DLike` context; the same function
  paints the on-screen viewport and the export. Tested with a software canvas.
- `ScreenshotEditor.tsx`: toolbar, pointer handling and Save/Cancel wiring. The
  `surface` prop is the drawing/encoding port; tests inject it, production uses
  `createDomSurface` with DOM canvases.

## Tests

- `geometry.test.ts`, `model.test.ts`, `export.test.ts`: pure functions, including
  crop math, undo and per-pixel redaction coverage.
- `ScreenshotEditor.test.tsx`: component seam — Save/Cancel callback semantics,
  tool interactions, stroke width, text, crop and undo through the public props.
