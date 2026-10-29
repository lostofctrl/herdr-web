/* global window, document, location, innerWidth, innerHeight, requestAnimationFrame */
/* eslint-disable @typescript-eslint/no-unused-expressions -- playwright-cli evaluates a function expression */
async page => {
  // run-code evaluates this expression in a VM without require. Its host page
  // exposes Node's Function constructor; Node >=22 provides getBuiltinModule.
  const fs = page.constructor.constructor('return process.getBuiltinModule("node:fs")')();
  const URL = page.constructor.constructor('return URL')();
  const directory = '/tmp/pi-thumb-composer-evidence';
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const directoryStat = fs.lstatSync(directory);
  const uid = page.constructor.constructor('return process.getuid?.()')();
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() ||
      (uid !== undefined && directoryStat.uid !== uid)) {
    throw new Error(`Refusing non-owned directory or symlink: ${directory}`);
  }
  fs.chmodSync(directory, 0o700);
  // O_NOFOLLOW also makes repeated captures safe if an output was replaced by a symlink.
  const write = (name, contents) => fs.writeFileSync(`${directory}/${name}`, contents, {
    flag: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
    mode: 0o600,
  });
  const browser = page.context().browser();
  if (!browser) throw new Error('A connected Chromium browser is required.');
  if (browser.browserType().name() !== 'chromium') throw new Error('Use Chromium, not WebKit or Firefox.');

  const devices = [
    { name: 'iPhone-13-Chromium', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3,
      userAgent: 'Mozilla/5.0 (Linux; Android 13; iPhone 13 Chromium emulation) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Chromium/131.0.0.0' },
    { name: 'Pixel-7-Chromium', viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625,
      userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Chromium/131.0.0.0' },
  ];
  const report = {
    generatedAt: new Date().toISOString(),
    engine: 'Chromium', keyboard: '300px geometry simulation; NOT a native keyboard',
    devices, captures: [], flows: [], failures: [],
  };
  const fail = (where, message) => {
    if (report.failures.length < 200) report.failures.push({ where, message: String(message).slice(0, 600) });
    else report.failuresTruncated = true;
  };
  const backend = url => /^\/(api|ws)(\/|$)/.test(new URL(url).pathname);
  const route = (variant, keyboard = false) =>
    `http://127.0.0.1:5177/?prototype=pi-composer&variant=${variant}${keyboard ? '&keyboard=1' : ''}`;
  const assert = (condition, message) => { if (!condition) throw new Error(message); };

  async function isolated(device, work) {
    const context = await browser.newContext({
      viewport: device.viewport, deviceScaleFactor: device.deviceScaleFactor,
      userAgent: device.userAgent, isMobile: true, hasTouch: true,
      serviceWorkers: 'block', reducedMotion: 'reduce', acceptDownloads: false,
    });
    const violations = [];
    const record = message => {
      if (violations.length < 100) violations.push(String(message).slice(0, 300));
    };
    try {
      context.on('request', request => { if (backend(request.url())) record(`backend request: ${request.method()} ${new URL(request.url()).pathname}`); });
      await context.route(/\/((api|ws)(\/|\?|$))/, async intercepted => {
        if (backend(intercepted.request().url())) {
          record(`blocked backend request: ${new URL(intercepted.request().url()).pathname}`);
          await intercepted.abort();
        } else await intercepted.continue();
      });
      await context.routeWebSocket(/\/((api|ws)(\/|\?|$))/, socket => {
        if (backend(socket.url())) {
          record(`blocked backend WebSocket: ${new URL(socket.url()).pathname}`);
          socket.close();
        } else socket.connectToServer();
      });
      await context.exposeBinding('__composerEvidenceViolation', (_, message) => record(message));
      await context.addInitScript(() => {
        const pending = [];
        const record = message => pending.push(window.__composerEvidenceViolation(message));
        window.__composerEvidenceFlush = () => Promise.all(pending);
        for (const kind of ['localStorage', 'sessionStorage']) {
          const storage = window[kind];
          const wrapped = new Proxy(storage, {
            get(target, property) {
              if (['setItem', 'removeItem', 'clear'].includes(property)) {
                return (...args) => { record(`${kind}.${property} write`); return target[property](...args); };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
            set(target, property, value) { record(`${kind} property write`); return Reflect.set(target, property, value); },
            defineProperty(target, property, descriptor) { record(`${kind} property definition`); return Reflect.defineProperty(target, property, descriptor); },
            deleteProperty(target, property) { record(`${kind} property deletion`); return Reflect.deleteProperty(target, property); },
          });
          Object.defineProperty(window, kind, { configurable: false, get: () => wrapped });
        }
        window.WebSocket = new Proxy(window.WebSocket, {
          construct(target, args) {
            const url = new URL(String(args[0]), location.href);
            if (/^\/(api|ws)(\/|$)/.test(url.pathname)) {
              record(`backend WebSocket attempt: ${url.pathname}`);
              throw new Error('Prototype evidence blocked backend WebSocket');
            }
            return Reflect.construct(target, args);
          },
        });
      });
      const tab = await context.newPage();
      tab.setDefaultTimeout(5000);
      try { await work(tab); }
      finally {
        await tab.evaluate(() => window.__composerEvidenceFlush?.()).catch(error => record(`spy flush failed: ${error.message}`));
        for (const violation of violations) fail(tab.url(), violation);
      }
    } finally { await context.close(); }
  }

  async function audit(tab, focused) {
    return tab.evaluate(({ focused }) => {
      const shell = document.querySelector('[data-prototype-shell]');
      if (!shell) throw new Error('Missing [data-prototype-shell]');
      const rect = element => {
        const r = element.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
      };
      const visible = element => {
        const r = element.getBoundingClientRect();
        return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
          r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.x < innerWidth && r.y < innerHeight &&
          element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      };
      const name = element => {
        const labelled = (element.getAttribute('aria-labelledby') || '').split(/\s+/)
          .map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
        return (element.getAttribute('aria-label') || labelled ||
          Array.from(element.labels || []).map(label => label.textContent).join(' ') ||
          element.getAttribute('alt') || element.getAttribute('title') ||
          element.textContent || element.getAttribute('placeholder') || element.tagName).trim().slice(0, 120);
      };
      const elements = Array.from(document.querySelectorAll('button,a,input,textarea,select,summary,[role="button"],[tabindex]'))
        .filter(element => (element.matches('button,a,input,textarea,select,summary,[role="button"]') || element.tabIndex >= 0) && visible(element));
      if (elements.length > 250) throw new Error(`Audit bound exceeded: ${elements.length} visible controls (limit 250); no partial audit accepted`);
      const controls = elements.map((element, index) => ({ index, tag: element.tagName.toLowerCase(), name: name(element), rect: rect(element) }));
      const failures = [];
      const add = message => { if (failures.length < 100) failures.push(message); };
      for (const control of controls) {
        if (control.rect.width < 44 || control.rect.height < 44) add(`Target ${control.index} (${control.name}) is ${control.rect.width}x${control.rect.height}; minimum 44x44`);
      }
      for (let i = 0; i < controls.length; i++) {
        for (let j = i + 1; j < controls.length; j++) {
          const a = controls[i].rect, b = controls[j].rect;
          const dx = Math.max(a.x - b.right, b.x - a.right, 0);
          const dy = Math.max(a.y - b.bottom, b.y - a.bottom, 0);
          if ((dx === 0 || dy === 0) && Math.hypot(dx, dy) < 8) {
            add(`Controls ${i} (${controls[i].name}) / ${j} (${controls[j].name}) separation ${Math.hypot(dx, dy)}px; minimum 8px`);
          }
        }
      }
      const shellRect = rect(shell);
      const primary = Array.from(document.querySelectorAll('button[data-primary]')).filter(visible)
        .map(element => ({ name: name(element), rect: rect(element) }));
      for (const button of primary) {
        if (button.rect.y < shellRect.y + shellRect.height * 2 / 3 || button.rect.bottom > shellRect.bottom + 1) {
          add(`Primary ${button.name} is not wholly in shell bottom third`);
        }
      }
      const horizontalOverflow = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 1 || shell.scrollWidth > shell.clientWidth + 1;
      if (horizontalOverflow) add('Horizontal overflow');
      const terminalVisible = Array.from(document.querySelectorAll('[data-terminal]')).some(visible);
      if (focused && terminalVisible) add('Terminal visible while composer focused');
      const stateElement = document.querySelector('[data-state-json]');
      const stateText = stateElement?.textContent || stateElement?.getAttribute('data-state-json') || '';
      return { controls, primary, shell: shellRect, viewport: { width: innerWidth, height: innerHeight },
        simulatedBottomGap: innerHeight - shellRect.bottom, horizontalOverflow, terminalVisible,
        stateJSON: stateText.slice(0, 4000), failures, failuresAtLimit: failures.length === 100 };
    }, { focused });
  }

  async function state(tab, expected) {
    await tab.waitForFunction(expected => {
      const shell = document.querySelector('[data-prototype-shell]');
      if (shell?.getAttribute('data-state') === expected) return true;
      const element = document.querySelector('[data-state-json]');
      try {
        const value = JSON.parse(element?.textContent || element?.getAttribute('data-state-json') || '{}');
        return [value.state, value.mode, value.composerState, value.state?.mode].includes(expected);
      } catch { return false; }
    }, expected, { timeout: 5000 });
  }

  for (const device of devices) {
    for (const variant of ['A', 'B', 'C']) {
      for (const view of ['collapsed', 'focused', 'keyboard']) {
        const id = `${device.name}-${variant}-${view}`;
        const capture = { id, variant, device: device.name, view, screenshot: `${id}.png` };
        report.captures.push(capture);
        try {
          await isolated(device, async tab => {
            await tab.goto(route(variant, view === 'keyboard'), { waitUntil: 'networkidle' });
            await tab.locator('[data-prototype-shell]').waitFor();
            if (view !== 'collapsed') await tab.locator('[data-action="open"]').click();
            await state(tab, view === 'collapsed' ? 'collapsed' : 'focused');
            await tab.evaluate(async () => {
              await document.fonts.ready;
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            });
            capture.audit = await audit(tab, view !== 'collapsed');
            for (const message of capture.audit.failures) fail(id, message);
            if (view === 'keyboard' && Math.abs(capture.audit.simulatedBottomGap - 300) > 2) {
              fail(id, `Keyboard simulation must leave a 300px shell-bottom gap; observed ${capture.audit.simulatedBottomGap}px`);
            }
            write(capture.screenshot, await tab.screenshot({ fullPage: true, animations: 'disabled', scale: 'css' }));
          });
        } catch (error) { capture.error = String(error.message).slice(0, 600); fail(id, error.message); }
      }
    }
  }

  for (const variant of ['A', 'B', 'C']) {
    const flow = { variant, steps: [], audits: [] };
    report.flows.push(flow);
    try {
      await isolated(devices[0], async tab => {
        await tab.goto(route(variant), { waitUntil: 'networkidle' });
        await tab.locator('[data-action="open"]').click();
        await state(tab, 'focused');
        const prompt = tab.getByRole('textbox', { name: 'Pi prompt', exact: true });
        const draft = `Fixture-only retained draft ${variant}`;
        await prompt.fill(draft);
        await tab.locator('[data-action="send"]').click();
        await state(tab, 'sending');
        flow.steps.push('Send -> sending');
        const send = tab.locator('[data-action="send"]');
        // A disabled/absent Send is already a repeat-submit guard; otherwise exercise it.
        if (await send.count() && await send.isVisible() && await send.isEnabled()) {
          await send.click();
          await state(tab, 'sending');
          flow.steps.push('Repeat Send stayed sending (no counter contract asserted)');
        } else flow.steps.push('Repeat Send unavailable while sending');
        await tab.getByRole('button', { name: 'Cancel', exact: true }).click();
        await state(tab, 'focused');
        assert(await prompt.inputValue() === draft, 'Cancel during sending lost draft');
        flow.steps.push('Cancel -> focused; draft retained');
        await tab.getByRole('button', { name: 'Terminal', exact: true }).click();
        await state(tab, 'collapsed');
        await tab.locator('[data-action="open"]').click();
        await state(tab, 'focused');
        assert(await prompt.inputValue() === draft, 'Reopening after Terminal lost draft');
        flow.steps.push('Terminal -> collapsed -> reopen; draft retained');
        await tab.getByRole('button', { name: 'Cancel', exact: true }).click();
        const dialog = tab.getByRole('dialog');
        await dialog.waitFor({ state: 'visible' });
        const dialogAudit = await audit(tab, true);
        flow.audits.push(dialogAudit);
        for (const message of dialogAudit.failures) fail(`flow-${variant}-dialog`, message);
        await dialog.getByRole('button', { name: 'Keep draft', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        await state(tab, 'focused');
        assert(await prompt.inputValue() === draft, 'Keep draft lost draft');
        flow.steps.push('Focused Cancel -> dialog -> Keep draft closes dialog');
        await tab.locator('[data-action="lab"]').click();
        const json = tab.locator('[data-state-json]');
        await json.waitFor({ state: 'visible' });
        JSON.parse(await json.textContent() || await json.getAttribute('data-state-json'));
        const beforeReply = await json.textContent() || await json.getAttribute('data-state-json');
        await tab.getByRole('button', { name: 'Agent reply', exact: true }).click();
        await tab.waitForFunction(before => {
          const node = document.querySelector('[data-state-json]');
          return (node?.textContent || node?.getAttribute('data-state-json')) !== before;
        }, beforeReply, { timeout: 5000 });
        flow.steps.push('Lab Agent reply updates live state JSON');
        for (const label of ['Keyboard', 'Background']) {
          const before = await json.textContent() || await json.getAttribute('data-state-json');
          await tab.getByRole('button', { name: label, exact: true }).click();
          await tab.waitForFunction(before => {
            const node = document.querySelector('[data-state-json]');
            return (node?.textContent || node?.getAttribute('data-state-json')) !== before;
          }, before, { timeout: 5000 });
          flow.steps.push(`Lab ${label} available, actionable, and updates live state JSON`);
        }
        const labAudit = await audit(tab, false);
        flow.audits.push(labAudit);
        for (const message of labAudit.failures) fail(`flow-${variant}-lab`, message);
        await tab.getByRole('button', { name: 'Keyboard', exact: true }).click();
        await tab.getByRole('button', { name: 'Close lab', exact: true }).click();
        await prompt.focus();
        await tab.setViewportSize({ width: 390, height: 544 });
        await tab.setViewportSize({ width: 390, height: 844 });
        await state(tab, 'focused');
        assert(await prompt.evaluate(element => element === document.activeElement), 'Resize without blur lost input focus');
        assert(await prompt.inputValue() === draft, 'Resize lost draft');
        flow.steps.push('Geometry shrinks/expands without blur; focused mode and draft retained (not native IME)');
        await tab.setViewportSize({ width: 844, height: 390 });
        await tab.waitForFunction(() => Math.abs(document.querySelector('[data-prototype-shell]').getBoundingClientRect().width - innerWidth) < 2);
        const rotationAudit = await audit(tab, true);
        flow.audits.push(rotationAudit);
        for (const message of rotationAudit.failures) fail(`flow-${variant}-rotation`, message);
        await state(tab, 'focused');
        flow.steps.push('Landscape resize refits shell; geometry audited');
        await tab.setViewportSize({ width: 390, height: 844 });
        await tab.locator('[data-action="send"]').click();
        await state(tab, 'sending');
        await tab.locator('[data-action="terminal"]').click();
        await state(tab, 'collapsed');
        await tab.locator('[data-action="lab"]').click();
        await tab.getByRole('button', { name: 'Agent reply', exact: true }).click();
        await state(tab, 'collapsed');
        await tab.getByRole('button', { name: 'Close lab', exact: true }).click();
        await tab.locator('[data-action="open"]').click();
        await state(tab, 'focused');
        assert(await prompt.inputValue() === '', 'Completed unchanged sent draft should clear');
        assert((await tab.locator('[data-pair="latest"]').textContent()).includes('visualViewport'), 'Reply while collapsed did not update latest');
        await prompt.fill(draft);
        await tab.locator('[data-action="cancel"]').click();
        await state(tab, 'dialog open');
        await tab.locator('[data-action="lab"]').click();
        await tab.getByRole('button', { name: 'Agent reply', exact: true }).click();
        await state(tab, 'dialog open');
        await tab.getByRole('button', { name: 'Close lab', exact: true }).click();
        await tab.getByRole('button', { name: 'Keep draft', exact: true }).click();
        assert(await prompt.inputValue() === draft, 'Reply behind dialog lost draft');
        flow.steps.push('Reply while collapsed updates latest; reply behind dialog preserves dialog and draft');
        const before = new URL(tab.url()).searchParams.get('variant');
        await tab.getByRole('button', { name: 'Next variant', exact: true }).click();
        assert(new URL(tab.url()).searchParams.get('variant') !== before, 'Variant switch failed');
        assert(await prompt.inputValue() === draft, 'Variant switch lost draft');
        await tab.getByRole('button', { name: 'Previous variant', exact: true }).focus();
        await tab.keyboard.press('ArrowRight');
        assert(await prompt.inputValue() === draft, 'Arrow switch lost draft');
        flow.steps.push('Floating switcher + arrow key switch layouts with draft retained');
      });
    } catch (error) { flow.error = String(error.message).slice(0, 600); fail(`flow-${variant}`, error.message); }
  }

  report.ok = report.failures.length === 0 && report.captures.length === 18;
  const serialized = JSON.stringify(report, null, 2);
  if (serialized.length > 1000000) throw new Error('Audit exceeded 1 MB bound; refusing unbounded output');
  write('audit.json', serialized);
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pi composer fixture evidence</title>
<style>body{font:16px system-ui;background:#111;color:#eee;padding:24px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:24px}figure{margin:0}img{width:100%;max-width:412px}pre{white-space:pre-wrap}a{color:#9cf}</style>
<h1>Pi composer: ${report.ok ? 'PASS' : 'FAIL'}</h1><p>Chromium mobile emulation. Keyboard: 300px geometry simulation, not a native keyboard.</p><p><a href="audit.json">Full bounded audit JSON</a></p>
<pre>${escape(report.failures.map(item => `${item.where}: ${item.message}`).join('\n') || 'No audit failures.')}</pre><main>${report.captures.map(item => `<figure><figcaption>${escape(item.id)}</figcaption>${item.error ? `<p>${escape(item.error)}</p>` : `<img loading="lazy" src="${escape(item.screenshot)}" alt="${escape(item.id)}">`}</figure>`).join('')}</main></html>`;
  write('index.html', html);
  if (!report.ok) throw new Error(`Pi composer evidence failed: ${report.failures.length}${report.failuresTruncated ? '+' : ''} failures. See ${directory}/audit.json and index.html. First: ${report.failures[0]?.message}`);
  return { ok: true, screenshots: 18, audit: `${directory}/audit.json`, gallery: `${directory}/index.html`, keyboard: report.keyboard };
}
