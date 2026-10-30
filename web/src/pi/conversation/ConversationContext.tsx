import { useLayoutEffect, useRef, type ReactNode } from "react";
import { usePiBridge } from "../PiBridgeContext";
import type { PiConversationExchange } from "../piConversation";
import { ReaderMarkdown } from "../reader/ReaderMarkdown";
import "./conversation-context.css";

const STATUS = {
  pending: "Pending reply",
  running: "Running",
  complete: "Complete",
  aborted: "Aborted",
  error: "Error",
} as const;

function Exchange({ exchange, label, current }: { exchange: PiConversationExchange; label: string; current: boolean }) {
  const body = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    if (current && pinned.current && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [current, exchange.user, exchange.assistant, exchange.status, exchange.user_truncated, exchange.assistant_truncated]);
  // Keyboard, rail or chip changes resize the body without changing text; keep a pinned reader at its end.
  useLayoutEffect(() => {
    const node = body.current;
    if (!current || !node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (pinned.current) node.scrollTop = node.scrollHeight; });
    observer.observe(node);
    return () => observer.disconnect();
  }, [current]);
  return <article className={`pi-conversation-exchange ${current ? "pi-conversation-current" : "pi-conversation-first"}`}>
    <header><strong>{label}</strong><span className="pi-conversation-status">{STATUS[exchange.status]}</span></header>
    <div ref={body} className="pi-conversation-body" tabIndex={0} onScroll={(event) => {
      const node = event.currentTarget;
      pinned.current = node.scrollHeight - node.clientHeight - node.scrollTop <= 2;
    }}>
      <div className="pi-conversation-user"><b>You</b><p>{exchange.user || "[No public user text]"}</p></div>
      {exchange.user_truncated ? <p className="pi-conversation-status">User text truncated.</p> : null}
      {exchange.assistant ? <div className="pi-conversation-assistant"><b>Pi</b><ReaderMarkdown text={exchange.assistant} copyCode={false} /></div> : null}
      {exchange.assistant_truncated ? <p className="pi-conversation-status">Assistant text truncated.</p> : null}
    </div>
  </article>;
}

/** Public, recorded branch text only; it never owns input or prompt delivery. */
export function ConversationContext({ paneId, editor }: { paneId: string; editor?: ReactNode }) {
  const bridge = usePiBridge(paneId);
  const conversation = bridge?.status === "online" ? bridge.conversation : null;
  const available = conversation?.availability === "ready";
  const exchanges = available ? conversation.exchanges : [];
  const authority = JSON.stringify([paneId, conversation?.epoch, conversation?.session_id, conversation?.selection_generation]);
  const first = exchanges.length > 1 ? exchanges[0] : null;
  const current = exchanges.at(-1);
  return <section className="pi-conversation" role="region" aria-label="Conversation context" tabIndex={0}>
    <div className="pi-conversation-strip">
      {first ? <Exchange key={`${authority}:first`} exchange={first} label="First exchange" current={false} /> : (
        <article className="pi-conversation-exchange pi-conversation-first">
          <header><strong>First exchange</strong></header>
          <p className="pi-conversation-status">Empty</p>
        </article>
      )}
      {!available ? <p className="pi-conversation-status">Conversation context unavailable{bridge?.status === "offline" ? " — Bridge Offline" : ""}.</p> : available && exchanges.length === 0 ? <p className="pi-conversation-status">No recorded exchanges yet.</p> : null}
    </div>
    <div className="pi-conversation-working">
      {current ? <Exchange key={`${authority}:current`} exchange={current} label={exchanges.length === 1 ? "First / current exchange" : "Latest / current exchange"} current /> : (
        <article className="pi-conversation-exchange pi-conversation-current">
          <header><strong>Latest / current exchange</strong></header>
          <p className="pi-conversation-status">Empty</p>
        </article>
      )}
      {editor}
    </div>
  </section>;
}
