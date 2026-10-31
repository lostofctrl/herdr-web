/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import NoteMarkdownPreview from "./NoteMarkdownPreview";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("note image preview", () => {
  it("limits image loads in a large note and displays a notice", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const body = Array.from({ length: 30 }, (_, i) => `![image](/api/note-images/${i}.png)`).join("\n\n");
    await act(async () => {
      root.render(<NoteMarkdownPreview body={body} httpUrl={(path) => `https://bridge.test${path}`} />);
    });
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(20);
    expect(container.textContent).toContain("Image preview limit reached");
    await act(async () => root.unmount());
  });

  it("counts reference-style images and allows exactly 20", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const images = Array.from({ length: 20 }, () => "![image][ref]").join("\n\n");
    const bridgeUrl = (path: string) => `https://bridge.test${path}`;
    await act(async () => root.render(<NoteMarkdownPreview body={`${images}\n\n[ref]: /api/note-images/a.png`} httpUrl={bridgeUrl} />));
    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(container.textContent).not.toContain("Image preview limit reached");
    fetchMock.mockClear();
    await act(async () => root.render(<NoteMarkdownPreview body={`${images}\n\n![extra][ref]\n\n[ref]: /api/note-images/a.png`} httpUrl={bridgeUrl} />));
    expect(container.textContent).toContain("Image preview limit reached");
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("keeps images on text edits and reloads them when the bridge changes", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Blob(["image"])));
    vi.stubGlobal("fetch", fetchMock);
    const OriginalURL = URL;
    class TestURL extends OriginalURL {
      static createObjectURL = vi.fn(() => "blob:preview");
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", TestURL);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const bridgeUrl = (path: string) => `https://bridge.test${path}`;
    const body = "intro\n\n![image](/api/note-images/a.png)";
    await act(async () => root.render(<NoteMarkdownPreview body={body} httpUrl={bridgeUrl} />));
    await act(async () => root.render(<NoteMarkdownPreview body={body} httpUrl={bridgeUrl} />));
    await act(async () => root.render(<NoteMarkdownPreview body={body.replace("intro", "edited")} httpUrl={bridgeUrl} />));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(TestURL.revokeObjectURL).not.toHaveBeenCalled();
    await act(async () => root.render(<NoteMarkdownPreview body={body} httpUrl={(path) => `https://other.test${path}`} />));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("https://other.test/api/note-images/a.png");
    expect(TestURL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
    await act(async () => root.unmount());
  });

  it("loads only bridge-owned images and revokes their object URLs", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Blob(["image"])));
    vi.stubGlobal("fetch", fetchMock);
    const OriginalURL = URL;
    class TestURL extends OriginalURL {
      static createObjectURL = vi.fn(() => "blob:preview");
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", TestURL);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<NoteMarkdownPreview body={"![local](/api/note-images/abc.png) ![remote](https://evil.test/x.png)"} httpUrl={(path) => `https://bridge.test${path}`} />);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://bridge.test/api/note-images/abc.png", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:preview");
    expect(container.querySelectorAll("img")).toHaveLength(1);
    await act(async () => root.unmount());
    expect(TestURL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  });
});
