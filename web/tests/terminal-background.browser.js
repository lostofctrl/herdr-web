/* global document, setTimeout, devicePixelRatio */
/* eslint-disable @typescript-eslint/no-unused-expressions -- playwright-cli evaluates this function. */
// Run with playwright-cli run-code after opening any page on the Vite server.
// The routed fixture does not connect to a Herdr session.
(async (page) => {
  const origin = page.url().split("/").slice(0, 3).join("/");
  const results = [];
  for (const dpr of [1, 1.25, 1.5, 2, 2.25]) {
    const context = await page.context().browser().newContext({
      deviceScaleFactor: dpr,
      viewport: { width: 900, height: 400 },
    });
    try {
      await context.route("**/terminal-background-fixture", (route) => route.fulfill({
        contentType: "text/html",
        body: '<div id="terminal" style="width:800px;height:300px"></div>',
      }));
      const fixture = await context.newPage();
      await fixture.goto(`${origin}/terminal-background-fixture`);
      results.push(await fixture.evaluate(async () => {
        const { GhosttyRenderer } = await import("/src/terminalRenderer.ts");
        const renderer = new GhosttyRenderer(14, false);
        await renderer.mount(document.querySelector("#terminal"));
        const left = "\x1b[48;2;65;52;90m";
        const right = "\x1b[48;2;30;80;100m";
        const line = left + " ".repeat(20) + right + " ".repeat(20) + "\r\n";
        renderer.write("\x1b[?25l" + line.repeat(8));
        await new Promise((resolve) => setTimeout(resolve, 250));
        const canvas = document.querySelector("canvas");
        const ctx = canvas.getContext("2d");
        const width = Math.floor(300 * devicePixelRatio);
        const height = Math.floor(80 * devicePixelRatio);
        const data = ctx.getImageData(0, 0, width, height).data;
        const colors = new Set();
        for (let i = 0; i < data.length; i += 4) {
          colors.add(`${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`);
        }
        renderer.dispose();
        const expected = ["65,52,90,255", "30,80,100,255"];
        if (colors.size !== expected.length || expected.some((color) => !colors.has(color))) {
          throw new Error(`DPR ${devicePixelRatio}: unexpected background pixels ${[...colors]}`);
        }
        return { dpr: devicePixelRatio, colors: [...colors] };
      }));
    } finally {
      await context.close();
    }
  }
  return results;
})
