import { describe, expect, it } from "vitest";

import {
  piComposerAttachmentsFromFiles,
  piComposerImageFiles,
  piComposerNameForPng,
  piComposerUploadCandidates,
} from "./piComposerAttachments";
import { piComposerDeliveryParts, piComposerPromptText } from "./piComposerDelivery";

function imageFile(name: string, type = "image/png") {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

describe("piComposerPromptText", () => {
  it("puts the uploaded paths before the draft, in order", () => {
    expect(piComposerPromptText(["/a.png", "/b.png"], "why?")).toBe("/a.png /b.png why?");
  });

  it("keeps an image-only prompt free of a trailing space", () => {
    expect(piComposerPromptText(["/a.png"], "")).toBe("/a.png");
    expect(piComposerPromptText([], "text only")).toBe("text only");
    expect(piComposerPromptText([], "")).toBe("");
  });
});

describe("piComposerDeliveryParts", () => {
  it("wraps paths plus draft in one bracketed paste followed by Enter", () => {
    expect(piComposerDeliveryParts("hi", ["/a.png"])).toEqual([
      "\x1b[200~/a.png hi\x1b[201~",
      "\r",
    ]);
  });

  it("returns nothing when there is neither image nor text", () => {
    expect(piComposerDeliveryParts("", [])).toEqual([]);
  });
});

describe("piComposerAttachmentsFromFiles", () => {
  it("keeps image files in order and skips non-images", () => {
    const attachments = piComposerAttachmentsFromFiles([
      imageFile("one.png"),
      new File([new Uint8Array([1])], "notes.txt", { type: "text/plain" }),
      imageFile("two.jpg", "image/jpeg"),
    ]);
    expect(attachments.map((attachment) => attachment.name)).toEqual(["one.png", "two.jpg"]);
    expect(piComposerUploadCandidates(attachments).map((candidate) => candidate.name)).toEqual([
      "one.png",
      "two.jpg",
    ]);
  });

  it("reads images from a paste payload only", () => {
    const files = piComposerImageFiles({
      files: [imageFile("drop.png")],
      items: [
        { kind: "file", getAsFile: () => imageFile("paste.png") },
        { kind: "string", getAsFile: () => null },
      ],
    } as unknown as DataTransfer);
    expect(files.map((file) => file.name)).toEqual(["paste.png"]);
  });
});

describe("piComposerNameForPng", () => {
  it("renames edited images to PNG and falls back to a stable name", () => {
    expect(piComposerNameForPng("shot.jpg")).toBe("shot.png");
    expect(piComposerNameForPng("already.png")).toBe("already.png");
    expect(piComposerNameForPng(null)).toBe("screenshot.png");
    expect(piComposerNameForPng(" . ")).toBe("screenshot.png");
  });
});
