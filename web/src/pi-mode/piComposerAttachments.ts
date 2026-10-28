import type { ScreenshotImage } from "../pi/screenshot";
import type { UploadCandidate } from "../terminalUploads";

/** Same ceiling the terminal upload flow uses for one drop. */
export const PI_COMPOSER_MAX_ATTACHMENTS = 8;

/**
 * A Composer image attachment. The blob is the exact file that will be posted
 * to `/api/uploads`; the thumbnail URL only exists for the chip preview and is
 * revoked as soon as the chip goes away.
 */
export type PiComposerAttachment = {
  id: string;
  name: string | null;
  blob: Blob;
  thumbnailUrl: string;
};

let attachmentSequence = 0;

export function piComposerAttachmentsFromFiles(
  files: Iterable<File>,
): PiComposerAttachment[] {
  const attachments: PiComposerAttachment[] = [];
  for (const file of files) {
    if (!isImageFile(file)) {
      continue;
    }
    attachmentSequence += 1;
    attachments.push({
      id: `pi-attachment-${attachmentSequence}`,
      name: file.name.trim() || null,
      blob: file,
      thumbnailUrl: createThumbnailUrl(file),
    });
  }
  return attachments;
}

/** Images only: Attachment Chips are an image affordance, text files keep the terminal path. */
export function piComposerImageFiles(data: DataTransfer | null | undefined): File[] {
  if (!data) {
    return [];
  }
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") {
      continue;
    }
    const file = item.getAsFile();
    if (file && isImageFile(file)) {
      files.push(file);
    }
  }
  if (files.length === 0) {
    for (const file of Array.from(data.files ?? [])) {
      if (isImageFile(file)) {
        files.push(file);
      }
    }
  }
  return files;
}

export function piComposerUploadCandidates(
  attachments: PiComposerAttachment[],
): UploadCandidate[] {
  return attachments.map((attachment) => ({
    blob: attachment.blob,
    name: attachment.name,
  }));
}

export function releasePiComposerAttachment(attachment: PiComposerAttachment) {
  if (!attachment.thumbnailUrl) {
    return;
  }
  try {
    URL.revokeObjectURL(attachment.thumbnailUrl);
  } catch {
    // A missing or broken object-URL implementation must not block the Composer.
  }
}

/** Object URL for a chip preview; empty when the environment has no object URLs. */
export function piComposerThumbnailUrl(blob: Blob): string {
  return createThumbnailUrl(blob);
}

/**
 * The Screenshot Editor boundary takes the image's natural pixel size. Chips are
 * local blobs, so the size comes from an `Image` load of the chip's object URL.
 */
export async function piComposerScreenshotImage(
  attachment: PiComposerAttachment,
): Promise<ScreenshotImage> {
  const src = attachment.thumbnailUrl || createThumbnailUrl(attachment.blob);
  if (!src) {
    throw new Error("This image cannot be opened.");
  }
  const { width, height } = await loadNaturalSize(src);
  if (width <= 0 || height <= 0) {
    throw new Error("This image has no drawable size.");
  }
  return { src, width, height };
}

/** Replaces the chip image bytes with the editor's exported PNG. */
export function piComposerEditedAttachment(
  attachment: PiComposerAttachment,
  result: { dataUrl: string; width: number; height: number },
): PiComposerAttachment | null {
  const blob = piComposerBlobFromDataUrl(result.dataUrl);
  if (!blob) {
    return null;
  }
  return {
    ...attachment,
    name: piComposerNameForPng(attachment.name),
    blob,
    thumbnailUrl: createThumbnailUrl(blob),
  };
}

/** Export is always PNG, so the uploaded file name follows the bytes. */
export function piComposerNameForPng(name: string | null): string {
  const base = (name ?? "").trim();
  if (!base) {
    return "screenshot.png";
  }
  const withoutExtension = base.replace(/\.[^./\\]+$/, "").replace(/^\.+$/, "");
  return `${withoutExtension || "screenshot"}.png`;
}

export function piComposerBlobFromDataUrl(dataUrl: string): Blob | null {
  const match = /^data:([^,]*?),(.*)$/s.exec(dataUrl);
  if (!match) {
    return null;
  }
  const metadata = match[1];
  const mime = metadata.split(";")[0] || "image/png";
  const isBase64 = metadata.includes(";base64");
  try {
    const bytes = isBase64
      ? Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(match[2]));
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

function createThumbnailUrl(blob: Blob): string {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return "";
  }
  try {
    return URL.createObjectURL(blob);
  } catch {
    return "";
  }
}

function loadNaturalSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () =>
      resolve({
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
      });
    image.onerror = () => reject(new Error("This image cannot be opened."));
    image.src = src;
  });
}
