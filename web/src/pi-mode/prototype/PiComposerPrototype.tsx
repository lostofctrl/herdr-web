// THROWAWAY: three mobile composer layouts on ?prototype=pi-composer&variant=A|B|C.
// Fixtures only. Never connect this surface to a real terminal or persistent draft store.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { flushSync } from "react-dom";
import { piComposerDeliveryParts } from "../piComposerDelivery";
import { piControlsStackHeight } from "../piControlsHeight";
import "./prototype.css";

type Variant = "A" | "B" | "C";
type Pair = { user: string; agent: string };
const names = { A: "Conversation dock", B: "Thumb rail", C: "Context split" };
const first: Pair = {
  user: "Help me make the Pi composer comfortable on a phone. Keep the terminal as large as possible, preserve my draft, and let me read enough context to ask a useful follow-up.",
  agent: "I’ll separate reading from terminal work. The first exchange anchors the task; the latest exchange stays next to your draft. A keyboard resize must not silently return you to the terminal.\n\n```ts\nconst height = visualViewport?.height ?? innerHeight;\n// Focus is a mode, not a keyboard-height guess.\n```",
};
const latestFixture: Pair = {
  user: "The latest answer contains a long code example. What happens when I rotate the phone or dismiss the keyboard without leaving the prompt? Please keep the reply close to my input.",
  agent: "Keep the composer open. Resize it to the visible viewport, not the layout viewport. Your draft and the first exchange stay intact. Only an explicit Terminal action leaves this mode.\n\n```ts\nfunction measureViewport() {\n  const viewport = window.visualViewport;\n  return {\n    height: viewport?.height ?? innerHeight,\n    top: viewport?.offsetTop ?? 0,\n  };\n}\nvisualViewport?.addEventListener('resize', update);\nvisualViewport?.addEventListener('scroll', update);\n```\n\nTry closing the keyboard, then rotate. Read this last line and ask a follow-up: the reply stays immediately above the input, independently scrollable from the original context.",
};
const rows = [
  ["Open / focus", "Focused", "Stay", "Stay", "Stay"],
  ["Send", "Open first", "Sending; capture prompt", "Ignore duplicate", "Block"],
  ["Agent reply", "Update latest", "Update latest", "Focused; finish pair", "Update behind dialog"],
  ["Keyboard closes (no blur)", "Stay", "Stay fullscreen", "Stay fullscreen", "Stay"],
  ["Rotation / resize", "Refit terminal", "Refit viewport", "Refit viewport", "Refit viewport"],
  ["Background / foreground", "Keep in memory", "Keep mode + draft", "Keep pending", "Keep dialog + draft"],
  ["Cancel", "No-op", "Draft-choice dialog", "Stop; keep draft", "Close; keep draft"],
  ["Terminal", "Stay", "Collapse; keep draft", "Collapse; keep pending", "Close; collapse; keep draft"],
];

function Message({ text }: { text: string }) {
  return text.split(/```(?:\w+)?\n?|```/g).map((part, index) => index % 2
    ? <pre key={index}><code>{part.trim()}</code></pre>
    : <p key={index}>{part}</p>);
}
function Exchange({ pair, origin }: { pair: Pair; origin: "first" | "latest" }) {
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (origin === "latest" && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [origin, pair]);
  return <section className={`pp-exchange pp-${origin}`} data-pair={origin}>
    <div className="pp-exchange-label">{origin === "first" ? "01 / Session context" : "02 / Current exchange"} <span>FIXTURE</span></div>
    <div className="pp-pair-scroll" ref={scroll}><div className="pp-user"><b>You</b><Message text={pair.user} /></div>
      <div className="pp-agent"><b>Pi</b><Message text={pair.agent} /></div></div>
  </section>;
}

// Intentionally different structures: linear dock, inset sheet + right action rail,
// and a two-region context desk with a prominent independent current-reply pane.
export function VariantA({ context, current, editor }: { context: ReactNode; current: ReactNode; editor: ReactNode }) {
  return <div className="pp-layout pp-dock"><div className="pp-history">{context}{current}</div>{editor}</div>;
}
export function VariantB({ context, current, editor }: { context: ReactNode; current: ReactNode; editor: ReactNode }) {
  return <div className="pp-layout pp-rail"><aside className="pp-context-strip">{context}</aside><div className="pp-working-sheet">{current}{editor}</div></div>;
}
export function VariantC({ context, current, editor }: { context: ReactNode; current: ReactNode; editor: ReactNode }) {
  return <div className="pp-layout pp-split"><div className="pp-context-desk">{context}</div><div className="pp-current-desk">{current}</div>{editor}</div>;
}

export function PiComposerPrototype() {
  const params = new URLSearchParams(location.search);
  const [variant, setVariant] = useState<Variant>(() => {
    const value = params.get("variant");
    return value === "B" || value === "C" ? value : "A";
  });
  const [focused, setFocused] = useState(false);
  const [sending, setSending] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [lab, setLab] = useState(false);
  const [thumb, setThumb] = useState(false);
  const [keyboard, setKeyboard] = useState(params.get("keyboard") === "1");
  const [background, setBackground] = useState(false);
  const [draft, setDraft] = useState("");
  const [latest, setLatest] = useState(latestFixture);
  const [event, setEvent] = useState("Ready · fixtures only");
  const [parts, setParts] = useState(0);
  const [viewport, setViewport] = useState({ height: innerHeight, width: innerWidth, top: 0, left: 0 });
  const field = useRef<HTMLTextAreaElement>(null);
  const sent = useRef<string | null>(null);
  const pending = useRef(false);
  const editor = useRef<HTMLDivElement>(null);
  const [controlHeight, setControlHeight] = useState<number | null>(null);
  const mode = dialog ? "dialog open" : !focused ? "collapsed" : sending ? "sending" : "focused";

  useEffect(() => {
    const measure = () => {
      const vv = window.visualViewport;
      setViewport({ height: vv?.height ?? innerHeight, width: vv?.width ?? innerWidth, top: vv?.offsetTop ?? 0, left: vv?.offsetLeft ?? 0 });
    };
    const visibility = () => {
      setBackground(document.hidden);
      setEvent(document.hidden ? "App backgrounded · memory kept" : "App foregrounded · mode restored");
    };
    measure();
    visualViewport?.addEventListener("resize", measure);
    visualViewport?.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      visualViewport?.removeEventListener("resize", measure);
      visualViewport?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  useEffect(() => {
    if (!editor.current) return;
    const observer = new ResizeObserver(([entry]) => setControlHeight(entry.contentRect.height));
    observer.observe(editor.current);
    return () => observer.disconnect();
  }, [focused, variant]);

  const cycle = (direction: number) => {
    const variants: Variant[] = ["A", "B", "C"];
    const next = variants[(variants.indexOf(variant) + direction + 3) % 3];
    setVariant(next);
    const url = new URL(location.href);
    url.searchParams.set("variant", next);
    history.replaceState(null, "", url);
    setEvent(`Variant ${next} · draft and pending reply kept`);
  };
  useEffect(() => {
    const arrow = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input,textarea,[contenteditable]")) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        cycle(e.key === "ArrowRight" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", arrow);
    return () => window.removeEventListener("keydown", arrow);
  });
  const open = () => {
    flushSync(() => setFocused(true));
    setEvent("Open · native keyboard requested");
    // Stay inside the user gesture so iOS may open its keyboard.
    field.current?.focus();
  };
  const terminal = () => {
    field.current?.blur();
    setFocused(false);
    setDialog(false);
    setLab(false);
    setEvent("Return to terminal · draft kept in memory");
  };
  const send = () => {
    if (pending.current || !draft.trim() || dialog) return;
    pending.current = true;
    sent.current = draft;
    setParts(piComposerDeliveryParts(draft).length);
    setLatest({ user: draft, agent: "Simulated agent working… Cancel stops this local fixture. Use Lab → Agent reply to complete it." });
    setSending(true);
    setEvent("Sending · 2 formatted frames inspected, never delivered");
  };
  const cancel = () => {
    if (pending.current) {
      pending.current = false;
      setSending(false);
      setLatest(value => ({ ...value, agent: "Simulated reply cancelled. Your submitted prompt remains in the draft." }));
      setEvent("Cancel · pending reply stopped; draft kept");
    } else {
      field.current?.blur();
      setDialog(true);
      setEvent("Dialog open · choose what to do with draft");
    }
  };
  const reply = () => {
    setLatest(value => ({ ...value, agent: latestFixture.agent }));
    if (pending.current && draft === sent.current) setDraft("");
    pending.current = false;
    setSending(false);
    setEvent("Agent reply arrived · latest updated in place");
  };
  const height = Math.max(180, viewport.height - (keyboard && focused ? 300 : 0));
  const shellStyle = { height, width: viewport.width, top: viewport.top, left: viewport.left } as CSSProperties;
  const currentState = { mode, focused, sending, dialog, lab, draft, draftKept: !!draft, background, keyboardSimulation: keyboard && focused, viewport, controlHeight: piControlsStackHeight(52, controlHeight), formattedFrames: parts, source: "labelled fixtures; local memory only", event };
  const composer = <div className="pp-editor" ref={editor}>
    <div className="pp-draft"><label htmlFor="pp-prompt">{sending ? "Working · draft kept" : "Follow up"}</label>
      <textarea id="pp-prompt" aria-label="Pi prompt" ref={field} rows={2} placeholder="Ask Pi a follow-up…" value={draft}
        onChange={e => setDraft(e.target.value)} onFocus={() => setFocused(true)} /></div>
    <div className="pp-primary-actions">
      <button data-primary data-action="terminal" onClick={terminal}>Terminal</button>
      <button data-primary data-action="cancel" onClick={cancel}>Cancel</button>
      <button data-primary data-action="send" className="pp-send" disabled={sending || !draft.trim()} onClick={send}>{sending ? "Working…" : "Send ↑"}</button>
    </div>
  </div>;
  const layouts = { A: VariantA, B: VariantB, C: VariantC };
  const Layout = layouts[variant];
  return <main className={`pp-shell pp-variant-${variant}`} style={shellStyle} data-prototype-shell data-state={mode}>
    <header className="pp-header"><span>herdr <b>/ pi</b></span><span>THROWAWAY · ALL DATA STUBBED</span></header>
    <div className="pp-status">{mode.toUpperCase()} <span>{keyboard && focused ? "KEYBOARD SIMULATION −300px" : `${Math.round(height)}px visible`} · {draft ? "draft kept" : "no draft"}</span></div>
    {!focused ? <>
      <section className="pp-terminal" data-terminal aria-label="Stub terminal without CLI composer">
        <div className="pp-terminal-title">~/workspaces/mobile-composer <span>fixture terminal</span></div>
        <pre>{`pi • session mobile-layout-exploration\n\n› Keep the terminal as large as possible.\n\n● Read web/src/pi-mode/PiComposer.tsx\n● Read web/src/TerminalView.tsx\n● Inspect visible viewport geometry\n\n  First exchange anchors the task.\n  Latest exchange stays beside the input.\n\n  function measureViewport() {\n    return visualViewport?.height ?? innerHeight;\n  }\n\n✓ Draft preserved on Terminal\n✓ No CLI composer in this fixture\n✓ No real Pi session connected\n\n${latest.agent.startsWith("Simulated agent") ? "● Working…" : "● Reply available · open composer to read"}\n\nThe terminal uses all remaining space.\nThe compact launcher below is the only\ncomposer footprint, plus the prototype bar.`}</pre>
      </section>
      <div className="pp-launcher"><button data-primary data-action="open" aria-label="Write to Pi" onClick={open}>{variant === "B" ? "＋" : variant === "C" ? "↗" : "↗"}<span>{draft ? "Continue draft" : "Write to Pi"}</span><small>{variant}</small></button></div>
    </> : <Layout context={<Exchange pair={first} origin="first" />} current={<Exchange pair={latest} origin="latest" />} editor={composer} />}
    {thumb && <div className="pp-thumb" aria-hidden="true"><span>Bottom third · thumb zone</span></div>}
    {dialog && <div className="pp-overlay" role="dialog" aria-label="Keep draft dialog"><div className="pp-dialog-copy"><small>DRAFT OPTIONS</small><h2>Pick up where you left off.</h2><p>Cancel does not erase text. Keep your draft or explicitly discard it. Nothing is stored after reload.</p></div><div className="pp-dialog-actions"><button data-primary onClick={() => { setDialog(false); setEvent("Dialog closed · draft kept"); }}>Keep draft</button><button data-primary onClick={() => { setDraft(""); setDialog(false); setEvent("Draft discarded explicitly"); }}>Discard</button></div></div>}
    {lab && <div className="pp-overlay pp-lab" role="dialog" aria-label="Prototype laboratory"><div className="pp-lab-scroll">
      <small>LIVE STATE × EVENT TABLE</small><h2>{variant} / {names[variant]}</h2><p>Fixture-only. Draft survives mode changes, not reload. No native keyboard is emulated.</p>
      <pre data-state-json>{JSON.stringify(currentState, null, 2)}</pre>
      <div className="pp-table-scroll"><table><thead><tr>{["Event", "Collapsed", "Focused", "Sending", "Dialog open"].map(x => <th key={x} data-active={x.toLowerCase() === mode}>{x}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row[0]}>{row.map((cell, i) => <td key={i} data-active={i > 0 && ["collapsed", "focused", "sending", "dialog open"][i - 1] === mode}>{cell}</td>)}</tr>)}</tbody></table></div>
      <p>Last event: {event}. Rotate using the phone/browser. Real backgrounding uses visibilitychange; the Background button is a labelled simulation.</p>
    </div><div className="pp-lab-actions">
      <button onClick={() => setThumb(!thumb)}>Thumb zone {thumb ? "on" : "off"}</button>
      <button onClick={() => { setKeyboard(!keyboard); setEvent("Keyboard geometry toggled · no blur / no native keyboard"); }}>Keyboard</button>
      <button onClick={reply}>Agent reply</button>
      <button onClick={() => { setBackground(!background); setEvent("Background toggled · simulation; state kept"); }}>Background</button>
      <button onClick={() => { setLab(false); if (focused && !dialog) field.current?.focus(); }}>Close lab</button>
    </div></div>}
    <nav className="pp-switcher" aria-label="Prototype variants">
      <button aria-label="Previous variant" onClick={() => cycle(-1)}>←</button>
      <button data-action="lab" onClick={() => setLab(!lab)}>{variant} · {names[variant]} <small>{lab ? "Close lab" : "Lab / state"}</small></button>
      <button aria-label="Next variant" onClick={() => cycle(1)}>→</button>
    </nav>
  </main>;
}
