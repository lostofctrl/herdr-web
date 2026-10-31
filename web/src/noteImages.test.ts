import { describe, expect, it, vi, afterEach } from "vitest";
import { noteImagePath, uploadNoteImage } from "./noteImages";

afterEach(() => vi.unstubAllGlobals());

describe("note images", () => {
  it("only recognizes local note image references", () => {
    expect(noteImagePath("/api/note-images/abc-123.png")).toBe("/api/note-images/abc-123.png");
    for (const url of ["https://evil.test/a.png", "/api/note-images/../secret", "/api/note-images/a?x=1", "data:image/png;base64,AA"]) {
      expect(noteImagePath(url)).toBeNull();
    }
  });

  it("uploads to the note's bridge and validates the returned id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "abc-123.png" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new Blob(["image"], { type: "image/png" });
    await expect(uploadNoteImage((path) => `https://bridge.test${path}`, file)).resolves.toBe("/api/note-images/abc-123.png");
    expect(fetchMock).toHaveBeenCalledWith("https://bridge.test/api/note-images", expect.objectContaining({ method: "POST", body: file }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: "../unsafe" }), { status: 200 }));
    await expect(uploadNoteImage((path) => path, file)).rejects.toThrow();
  });
});
