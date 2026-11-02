/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InertMarkdown, MARKDOWN_PREVIEW_MAX_LENGTH } from "./InertMarkdown";

const roots: Root[] = [];
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function render(content: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<InertMarkdown content={content} />));
  return container;
}

describe("InertMarkdown", () => {
  it("renders standard formatting, GFM tables, and code as accessible content", async () => {
    const container = await render("# Heading\n\n**bold** and *emphasis* and ~~removed~~\n\n- one\n- two\n\n| Name | Value |\n| --- | --- |\n| A | B |\n\n`inline`\n\n```js\nconst x = '<tag>';\n```");
    expect(container.querySelector("h1")?.textContent).toBe("Heading");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("emphasis");
    expect(container.querySelector("del")?.textContent).toBe("removed");
    expect([...container.querySelectorAll("li")].map((node) => node.textContent)).toEqual(["one", "two"]);
    expect([...container.querySelectorAll("th")].map((node) => node.textContent)).toEqual(["Name", "Value"]);
    expect([...container.querySelectorAll("td")].map((node) => node.textContent)).toEqual(["A", "B"]);
    expect(container.querySelector("pre code")?.textContent).toBe("const x = '<tag>';\n");
    expect(container.querySelector("tag")).toBeNull();
  });

  it("represents links and images without navigation, resource loads, or active content", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const container = await render([
      "[external](https://example.com/a) [local](/api/sensitive) [script](javascript:alert%281%29)",
      "https://example.org and <user@example.org>",
      "![Diagram](https://example.com/image.png) ![Local image](/api/image) ![](/empty.png)",
      "<img src=\"https://example.com/raw\" onerror=\"alert(1)\">",
      "<iframe src=\"/api/sensitive\"></iframe><svg><script>alert(1)</script></svg>",
      "<a href=\"/api/sensitive\">raw link</a>",
    ].join("\n\n"));
    expect(container.textContent).toContain("external");
    expect(container.textContent).toContain("local");
    expect(container.textContent).toContain("script");
    expect(container.textContent).toContain("Diagram");
    expect(container.textContent).toContain("Local image");
    expect(container.querySelector("a, img, iframe, svg, script, object, embed, video, audio, source, link, form")).toBeNull();
    expect(container.querySelector("[href], [src], [srcset], [onerror], [onclick]")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders GFM task lists without editable controls and footnotes without navigation", async () => {
    const container = await render("- [x] done\n- [ ] pending\n\nA note[^1].\n\n[^1]: Footnote text");
    const checkboxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes.every((box) => box.disabled)).toBe(true);
    expect(checkboxes.map((box) => box.checked)).toEqual([true, false]);
    expect(container.textContent).toContain("Footnote text");
    expect(container.querySelector("a, [href]")).toBeNull();
  });

  it("accepts content at the limit and reports oversized content without rendering it", async () => {
    const atLimit = await render("a".repeat(MARKDOWN_PREVIEW_MAX_LENGTH));
    expect(atLimit.textContent).toBe("a".repeat(MARKDOWN_PREVIEW_MAX_LENGTH));
    const oversized = await render("# secret\n" + "x".repeat(MARKDOWN_PREVIEW_MAX_LENGTH));
    expect(oversized.querySelector('[role="alert"]')?.textContent).toBe("Markdown preview is too large to display.");
    expect(oversized.textContent).not.toContain("secret");
    expect(oversized.querySelector("h1")).toBeNull();
  });
});
