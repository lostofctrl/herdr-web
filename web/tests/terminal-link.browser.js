/* global document, window, setTimeout, fetch */
/* eslint-disable @typescript-eslint/no-unused-expressions -- playwright-cli evaluates this function. */
// Run with playwright-cli run-code against the Vite server. No Herdr session is used.
(async (page) => {
  const origin = page.url().split("/").slice(0, 3).join("/");
  const context = await page.context().browser().newContext({ viewport: { width: 900, height: 400 } });
  try {
    // Use the installed package even if the shared Vite server has a stale dependency cache.
    await context.route("**/node_modules/.vite/deps/ghostty-web.js?*", (route) => route.fulfill({
      path: "web/node_modules/ghostty-web/dist/ghostty-web.js", contentType: "text/javascript",
    }));
    await context.route("**/ghostty-vt.wasm*", (route) => route.fulfill({
      path: "web/node_modules/ghostty-web/dist/ghostty-vt.wasm", contentType: "application/wasm",
    }));
    await context.route("**/terminal-link-fixture", (route) => route.fulfill({
      contentType: "text/html",
      body: '<div id="terminal" style="width:800px;height:300px"></div>',
    }));
    const fixture = await context.newPage();
    await fixture.goto(`${origin}/terminal-link-fixture`);
    const point = await fixture.evaluate(async () => {
      const moduleText = await (await fetch("/src/terminalRenderer.ts")).text();
      const modulePath = moduleText.match(/import\("([^"]*ghostty-web[^"]*)"\)/)[1];
      const ghostty = await import(modulePath);
      const originalOpen = ghostty.Terminal.prototype.open;
      ghostty.Terminal.prototype.open = function (...args) {
        window.linkTestTerminal = this;
        return originalOpen.apply(this, args);
      };
      const { GhosttyRenderer } = await import("/src/terminalRenderer.ts");
      const renderer = new GhosttyRenderer(14, false);
      await renderer.mount(document.querySelector("#terminal"));
      renderer.setMouseCapture(true);
      window.linkTest = { opened: [], mouse: [], renderer };
      window.open = (url) => { window.linkTest.opened.push(url); return null; };
      renderer.onMouse((event) => window.linkTest.mouse.push(event));
      renderer.write("\x1b]8;;https://vscode.dev/redirect?url=test\x1b\\vscode:/test\x1b]8;;\x1b\\ " +
        "\x1b]8;;https://example.com/second\x1b\\other\x1b]8;;\x1b\\ " +
        "\x1b]8;;javascript:alert(1)\x1b\\unsafe\x1b]8;;\x1b\\");
      const terminal = window.linkTestTerminal;
      let cell;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        cell = terminal.buffer.active.getLine(0)?.getCell(0);
        if (cell?.getCodepoint() === 118) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const id = cell?.getHyperlinkId();
      const rect = document.querySelector("canvas").getBoundingClientRect();
      const info = { codepoint: cell?.getCodepoint(), id, uri: id ? terminal.wasmTerm?.getHyperlinkUri(0, 0) : null,
        viewportY: terminal.viewportY, scrollback: terminal.getScrollbackLength(), metrics: terminal.renderer.getMetrics() };
      if (!id || !info.uri) throw new Error(`Missing hyperlink: ${JSON.stringify(info)}`);
      return { x: rect.left + 4, y: rect.top + 8, secondX: rect.left + 13 * info.metrics.width + 4,
        unsafeX: rect.left + 19 * info.metrics.width + 4, blankX: rect.left + 500 };
    });
    await fixture.mouse.click(point.x, point.y);
    await fixture.keyboard.down("Control");
    await fixture.mouse.click(point.blankX, point.y);
    await fixture.mouse.click(point.unsafeX, point.y);
    await fixture.mouse.click(point.x, point.y);
    await fixture.mouse.click(point.secondX, point.y);
    await fixture.mouse.move(point.x, point.y);
    await fixture.mouse.down();
    await fixture.mouse.move(point.x + 20, point.y);
    await fixture.mouse.up();
    await fixture.evaluate(async () => {
      const terminal = window.linkTestTerminal;
      window.linkTest.renderer.write("\r\n".repeat(terminal.rows + 2));
      for (let attempt = 0; attempt < 50 && terminal.getScrollbackLength() === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const scrollback = terminal.getScrollbackLength();
      if (!scrollback) throw new Error("Terminal did not create scrollback");
      terminal.scrollLines(-scrollback);
      if (terminal.getViewportY() !== scrollback) throw new Error("Terminal did not scroll to the first line");
    });
    await fixture.mouse.click(point.x, point.y);
    await fixture.keyboard.up("Control");
    await fixture.keyboard.down("Meta");
    await fixture.mouse.click(point.unsafeX, point.y);
    await fixture.keyboard.up("Meta");
    const result = await fixture.evaluate(() => {
      const { opened, mouse, renderer } = window.linkTest;
      renderer.dispose();
      return { opened, mouse: mouse.filter((event) => event.kind === "down" || event.kind === "up") };
    });
    if (JSON.stringify(result.opened) !== JSON.stringify([
      "https://vscode.dev/redirect?url=test", "https://example.com/second", "https://vscode.dev/redirect?url=test",
    ])) {
      throw new Error(`Unexpected link interaction: ${JSON.stringify(result)}`);
    }
    if (result.mouse.length !== 8 || result.mouse[0].modifiers !== 0 ||
        result.mouse[2].modifiers !== 2 || result.mouse[4].modifiers !== 2 || result.mouse[6].modifiers !== 8) {
      throw new Error(`Unexpected forwarded mouse events: ${JSON.stringify(result.mouse)}`);
    }
    return result;
  } finally {
    await context.close();
  }
})
