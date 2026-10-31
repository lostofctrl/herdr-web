import type { BridgeHttpUrl } from "./bridgeApi";

const NOTE_IMAGE_PATH = /^\/api\/note-images\/[a-zA-Z0-9_-]+\.(?:png|jpg|gif|webp)$/;

export class NoteImageStorageFullError extends Error {}

export function noteImagePath(value: string): string | null {
  return NOTE_IMAGE_PATH.test(value) ? value : null;
}

export async function uploadNoteImage(httpUrl: BridgeHttpUrl, file: Blob): Promise<string> {
  const response = await fetch(httpUrl("/api/note-images"), {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  const result: unknown = await response.json().catch(() => null);
  if (response.status === 507) throw new NoteImageStorageFullError("Image storage is full. Contact the bridge administrator.");
  if (!response.ok) throw new Error(`Image upload failed (${response.status})`);
  const id = typeof result === "object" && result !== null && "id" in result ? result.id : null;
  const path = typeof id === "string" ? noteImagePath(`/api/note-images/${id}`) : null;
  if (!path) throw new Error("Invalid image upload response");
  return path;
}
