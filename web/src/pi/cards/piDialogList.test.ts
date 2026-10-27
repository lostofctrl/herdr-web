import { describe, expect, it } from "vitest";

import { visiblePiDialogs } from "./piDialogList";
import type { PiDialog } from "../piProtocol";

const question: PiDialog = { id: "q1", kind: "question", questions: [] };
const prompt: PiDialog = { id: "g1", kind: "select", options: [{ label: "Alpha" }] };
const confirm: PiDialog = { id: "g2", kind: "confirm" };

describe("visiblePiDialogs", () => {
  it("keeps question dialogs even when the generic wrap is unavailable", () => {
    expect(visiblePiDialogs([question, prompt], false)).toEqual([question]);
  });

  it("shows generic dialogs when the wrap installed", () => {
    expect(visiblePiDialogs([question, prompt, confirm], true)).toEqual([question, prompt, confirm]);
  });

  it("keeps arrival order and drops a repeated dialog id", () => {
    expect(visiblePiDialogs([prompt, question, prompt], true)).toEqual([prompt, question]);
  });

  it("returns nothing for no dialogs", () => {
    expect(visiblePiDialogs([], true)).toEqual([]);
  });
});
