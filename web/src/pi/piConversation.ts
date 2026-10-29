export type PiConversationExchange = {
  user: string;
  assistant: string;
  status: "pending" | "running" | "complete" | "aborted" | "error";
  user_truncated: boolean;
  assistant_truncated: boolean;
};

export type PiConversation = {
  type: "conversation_update";
  schema_version: 1;
  epoch: string;
  session_id: string | null;
  leaf_id: string | null;
  selection_generation: number;
  revision: number;
  availability: "ready" | "unavailable";
  reason: string | null;
  exchanges: PiConversationExchange[];
  request_id?: string;
};

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

/** Conversation is an independent, bounded trust boundary, not a legacy snapshot field. */
export function parseConversation(raw: string): PiConversation | null {
  if (bytes(raw) > 65536) return null;
  try {
    const value = JSON.parse(raw) as PiConversation;
    if (value?.type !== "conversation_update" || value.schema_version !== 1 ||
        typeof value.epoch !== "string" || !value.epoch ||
        !(value.session_id === null || typeof value.session_id === "string") ||
        !(value.leaf_id === null || typeof value.leaf_id === "string") ||
        !Number.isSafeInteger(value.selection_generation) || value.selection_generation < 1 ||
        !Number.isSafeInteger(value.revision) || value.revision < 1 ||
        !["ready", "unavailable"].includes(value.availability) ||
        !(value.reason === null || typeof value.reason === "string") ||
        (value.request_id !== undefined && typeof value.request_id !== "string") ||
        !Array.isArray(value.exchanges) || value.exchanges.length > 2) return null;
    if (value.availability === "ready" && !value.session_id) return null;
    if (value.availability === "unavailable" && value.exchanges.length) return null;
    for (const exchange of value.exchanges) {
      if (!exchange || typeof exchange.user !== "string" || typeof exchange.assistant !== "string" ||
          bytes(exchange.user) > 16384 || bytes(exchange.assistant) > 16384 ||
          typeof exchange.user_truncated !== "boolean" || typeof exchange.assistant_truncated !== "boolean" ||
          !["pending", "running", "complete", "aborted", "error"].includes(exchange.status)) return null;
    }
    const metadata = { ...value, exchanges: value.exchanges.map((e) => ({ ...e, user: "", assistant: "" })) };
    if (bytes(JSON.stringify(metadata)) > 8192) return null;
    return value;
  } catch {
    return null;
  }
}
