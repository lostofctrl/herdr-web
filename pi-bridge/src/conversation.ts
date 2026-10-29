import type { ContextLike, SessionEntryLike } from "./state.ts";

export type Exchange = {
  user: string;
  assistant: string;
  status: "pending" | "running" | "complete" | "aborted" | "error";
  user_truncated: boolean;
  assistant_truncated: boolean;
};

export type ConversationRecord = {
  type: "conversation_update";
  schema_version: 1;
  epoch: string;
  session_id: string | null;
  leaf_id: string | null;
  selection_generation: number;
  revision: number;
  availability: "ready" | "unavailable";
  reason: string | null;
  exchanges: Exchange[];
  request_id?: string;
};

export function supportsConversation(context: ContextLike | null): boolean {
  const manager = context?.sessionManager;
  return Boolean(manager && typeof manager.getBranch === "function" && typeof manager.getSessionId === "function" && typeof manager.getLeafId === "function");
}

function publicText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}

export function conversationExchanges(entries: SessionEntryLike[], running: boolean): Exchange[] {
  const exchanges: Exchange[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message?.role === "user") {
      exchanges.push({ user: publicText(message.content), assistant: "", status: "pending", user_truncated: false, assistant_truncated: false });
    } else if (message?.role === "assistant" && exchanges.length) {
      const current = exchanges[exchanges.length - 1];
      const text = publicText(message.content);
      if (text) current.assistant += (current.assistant ? "\n\n" : "") + text;
      if (message.stopReason === "aborted" || message.stopReason === "error") current.status = message.stopReason;
      else if (text) current.status = "complete";
    }
  }
  const latest = exchanges.at(-1);
  if (running && latest && latest.status !== "aborted" && latest.status !== "error") latest.status = "running";
  return exchanges.length > 1 ? [exchanges[0], exchanges[exchanges.length - 1]] : exchanges;
}


export const CONVERSATION_RECORD_BYTES = 64 * 1024;
export const CONVERSATION_FIELD_BYTES = 16 * 1024;
export const CONVERSATION_METADATA_BYTES = 8 * 1024;

/** Fit the actual JSON envelope, allocating current/latest before first. */
export function capConversation(record: ConversationRecord): ConversationRecord {
  const source = record.exchanges;
  record.exchanges = source.map((exchange) => ({ ...exchange, user: "", assistant: "" }));
  const metadataBytes = Buffer.byteLength(JSON.stringify(record), "utf8");
  if (metadataBytes > CONVERSATION_METADATA_BYTES) {
    return { ...record, session_id: null, leaf_id: null, exchanges: [], availability: "unavailable", reason: "metadata_too_large", ...(record.request_id && Buffer.byteLength(record.request_id) > 1024 ? { request_id: undefined } : {}) };
  }
  let budget = CONVERSATION_RECORD_BYTES - metadataBytes;
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const original = source[index];
    const target = record.exchanges[index];
    const tail = index === source.length - 1;
    for (const key of ["user", "assistant"] as const) {
      const text = original[key].toWellFormed();
      const points = Array.from(text);
      let low = 0;
      let high = Math.min(points.length, CONVERSATION_FIELD_BYTES);
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const candidate = (tail ? points.slice(points.length - middle) : points.slice(0, middle)).join("");
        if (Buffer.byteLength(candidate) <= CONVERSATION_FIELD_BYTES && Buffer.byteLength(JSON.stringify(candidate)) - 2 <= budget) low = middle;
        else high = middle - 1;
      }
      target[key] = (tail ? points.slice(points.length - low) : points.slice(0, low)).join("");
      target[`${key}_truncated`] = original[`${key}_truncated`] || target[key] !== original[key];
      budget -= Buffer.byteLength(JSON.stringify(target[key])) - 2;
    }
  }
  return record;
}
