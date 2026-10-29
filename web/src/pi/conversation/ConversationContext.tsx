import { usePiBridge } from "../PiBridgeContext";
import "./conversation-context.css";

const STATUS = {
  pending: "Pending reply",
  running: "Running",
  complete: "Complete",
  aborted: "Aborted",
  error: "Error",
} as const;

/** Public, recorded branch text only; it never owns input or prompt delivery. */
export function ConversationContext({ paneId }: { paneId: string }) {
  const bridge = usePiBridge(paneId);
  const conversation = bridge?.status === "online" ? bridge.conversation : null;
  const available = conversation?.availability === "ready";
  return (
    <section className="pi-conversation" role="region" aria-label="Conversation context" tabIndex={0}>
      {!available ? (
        <p className="pi-conversation-status">Conversation context unavailable{bridge?.status === "offline" ? " — Bridge Offline" : ""}.</p>
      ) : conversation.exchanges.length === 0 ? (
        <p className="pi-conversation-status">No recorded exchanges yet.</p>
      ) : conversation.exchanges.map((exchange, index) => (
        <article className="pi-conversation-exchange" key={index} tabIndex={0}>
          <header>
            <strong>{conversation.exchanges.length === 1 ? "First / current exchange" : index === 0 ? "First exchange" : "Latest / current exchange"}</strong>
            <span className="pi-conversation-status">{STATUS[exchange.status]}</span>
          </header>
          <p className="pi-conversation-text"><b>You: </b>{exchange.user || "[No public user text]"}</p>
          {exchange.user_truncated ? <p className="pi-conversation-status">User text truncated.</p> : null}
          {exchange.assistant ? <p className="pi-conversation-text"><b>Pi: </b>{exchange.assistant}</p> : null}
          {exchange.assistant_truncated ? <p className="pi-conversation-status">Assistant text truncated.</p> : null}
        </article>
      ))}
    </section>
  );
}
