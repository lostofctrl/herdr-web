import { parseConversation, type PiConversation } from "./piConversation";
import type {
  PiCapabilities,
  PiCatalog,
  PiDialog,
  PiSnapshotResult,
  PiState,
} from "./piProtocol";

export type PiBridgeStatus = "connecting" | "online" | "offline" | "unknown-pane";

export type PiBridgeState = {
  status: PiBridgeStatus;
  capabilities: PiCapabilities;
  state: PiState | null;
  catalog: PiCatalog | null;
  dialogs: PiDialog[];
  assistantMessage: string | null;
  conversation: PiConversation | null;
  lastError: string | null;
};

export const INITIAL_PI_BRIDGE_STATE: PiBridgeState = {
  status: "connecting",
  capabilities: {},
  state: null,
  catalog: null,
  dialogs: [],
  assistantMessage: null,
  conversation: null,
  lastError: null,
};

export const PI_RECONNECT_BASE_DELAY_MS = 500;
export const PI_RECONNECT_MAX_DELAY_MS = 5000;

export function piReconnectDelay(attempt: number) {
  return Math.min(PI_RECONNECT_BASE_DELAY_MS * 2 ** attempt, PI_RECONNECT_MAX_DELAY_MS);
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type PiBridgeClientOptions = {
  url: () => string;
  onState: (state: PiBridgeState) => void;
};

/**
 * Owns one `/ws/pi?pane_id=` relay connection. The React provider supplies the
 * URL and lifecycle; later Pi mode UI reads state and calls requests through it.
 */
export class PiBridgeClient {
  private readonly options: PiBridgeClientOptions;
  private state: PiBridgeState = { ...INITIAL_PI_BRIDGE_STATE };
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private disposed = false;
  private nextRequestId = 1;
  private pending = new Map<string, PendingRequest>();
  private conversationEpoch: string | null = null;
  private conversationGeneration = 0;
  private conversationRevision = 0;
  private conversationSession: string | null = null;
  private conversationRequestId: string | null = null;

  constructor(options: PiBridgeClientOptions) {
    this.options = options;
  }

  connect() {
    this.openSocket();
  }

  dispose() {
    this.disposed = true;
    this.clearReconnectTimer();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.rejectPending(new Error("Pi Bridge client disposed"));
  }

  /** Resends the snapshot when online; otherwise brings a stalled/offline connection back. */
  resync() {
    if (this.disposed) {
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.requestSnapshot();
      this.requestConversation();
      return;
    }
    if (!this.socket) {
      this.openSocket();
    }
  }

  request<T>(type: string, fields: Record<string, unknown> = {}): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Pi Bridge is offline"));
    }
    const id = String(this.nextRequestId++);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      try {
        socket.send(JSON.stringify({ type, id, ...fields }));
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private openSocket() {
    if (this.disposed) {
      return;
    }
    this.clearReconnectTimer();
    const socket = new WebSocket(this.options.url());
    this.socket = socket;
    let settled = false;

    const disconnect = (code: number, reason: string) => {
      if (settled || this.disposed || this.socket !== socket) {
        return;
      }
      settled = true;
      this.socket = null;
      this.conversationEpoch = null;
      this.conversationRequestId = null;
      this.rejectPending(new Error(reason || "Pi Bridge connection closed"));
      if (code === 4501) {
        this.patch({ status: "unknown-pane", lastError: reason || "unknown_pane", conversation: null });
        return;
      }
      this.patch({ status: "offline", lastError: reason || `relay_closed_${code}`, conversation: null });
      this.scheduleReconnect();
    };

    socket.addEventListener("open", () => {
      if (this.disposed || this.socket !== socket) {
        return;
      }
      this.reconnectAttempts = 0;
      this.patch({ status: "online", lastError: null });
      this.requestSnapshot();
    });
    socket.addEventListener("message", (event) => {
      if (this.disposed || this.socket !== socket || typeof event.data !== "string") {
        return;
      }
      this.handleRecord(event.data);
    });
    socket.addEventListener("close", (event) => {
      const close = event as CloseEvent;
      disconnect(close.code ?? 1006, close.reason ?? "");
    });
    socket.addEventListener("error", () => {
      if (settled) {
        return;
      }
      disconnect(1006, "connect_failed");
      socket.close();
    });
  }

  private requestConversation() {
    this.patch({ conversation: null });
    if (!this.state.capabilities.conversation_snapshot || !this.conversationEpoch) return;
    const id = String(this.nextRequestId);
    this.conversationRequestId = id;
    void this.request("get_conversation", { schema_version: 1 }).catch(() => {
      if (this.conversationRequestId === id) this.patch({ conversation: null });
    });
  }

  private requestSnapshot() {
    void this.request<PiSnapshotResult>("get_snapshot")
      .then((result) => {
        if (this.disposed) {
          return;
        }
        this.patch({
          state: result.state ?? null,
          catalog: result.catalog ?? null,
          dialogs: Array.isArray(result.dialogs) ? result.dialogs : [],
          assistantMessage: result.assistant_message ?? null,
        });
      })
      .catch(() => {
        // A close already moved the bridge Offline; a late error has no extra state.
      });
  }

  private handleRecord(raw: string) {
    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object") {
        return;
      }
      record = parsed as Record<string, unknown>;
    } catch {
      this.patch({ conversation: null });
      return;
    }

    switch (record.type) {
      case "conversation_update": {
        if (!this.state.capabilities.conversation_snapshot || !this.conversationEpoch) return;
        const value = parseConversation(raw);
        if (!value) {
          this.patch({ conversation: null });
          return;
        }
        if (value.epoch !== this.conversationEpoch ||
            (value.request_id !== undefined && value.request_id !== this.conversationRequestId) ||
            value.selection_generation < this.conversationGeneration || value.revision <= this.conversationRevision) return;
        if (value.selection_generation === this.conversationGeneration && this.conversationSession &&
            value.session_id && value.session_id !== this.conversationSession) return;
        this.conversationGeneration = value.selection_generation;
        this.conversationRevision = value.revision;
        this.conversationSession = value.session_id;
        this.patch({ conversation: value });
        return;
      }
      case "hello": {
        const epoch = record.protocol_version === 1 && typeof record.conversation_epoch === "string" ? record.conversation_epoch : null;
        if (epoch !== this.conversationEpoch) {
          this.conversationEpoch = epoch;
          this.conversationGeneration = 0;
          this.conversationRevision = 0;
          this.conversationSession = null;
        }
        this.patch({
          conversation: null,
          capabilities:
            record.capabilities && typeof record.capabilities === "object"
              ? (record.capabilities as PiCapabilities)
              : {},
        });
        this.requestConversation();
        return;
      }
      case "state":
        this.patch({ state: record as unknown as PiState });
        return;
      case "catalog":
        this.patch({ catalog: record as unknown as PiCatalog });
        return;
      case "dialog_open":
        this.openDialog(record.dialog as PiDialog | undefined);
        return;
      case "dialog_closed":
        this.patch({
          dialogs: this.state.dialogs.filter((dialog) => dialog.id !== record.id),
        });
        return;
      case "assistant_message":
        this.patch({
          assistantMessage: typeof record.text === "string" ? record.text : null,
        });
        return;
      case "response":
        this.resolveResponse(record);
        return;
      default:
        return;
    }
  }

  private openDialog(dialog: PiDialog | undefined) {
    if (!dialog || typeof dialog.id !== "string") {
      return;
    }
    const dialogs = this.state.dialogs.filter((current) => current.id !== dialog.id);
    this.patch({ dialogs: [...dialogs, dialog] });
  }

  private resolveResponse(record: Record<string, unknown>) {
    const pending = this.pending.get(String(record.id));
    if (!pending) {
      return;
    }
    this.pending.delete(String(record.id));
    if (record.ok === false) {
      pending.reject(new Error(typeof record.error === "string" ? record.error : "request failed"));
      return;
    }
    pending.resolve(record.result);
  }

  private scheduleReconnect() {
    if (this.disposed || this.reconnectTimer !== null) {
      return;
    }
    const delay = piReconnectDelay(this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private rejectPending(error: Error) {
    const pending = this.pending;
    this.pending = new Map();
    for (const request of pending.values()) {
      request.reject(error);
    }
  }

  private patch(partial: Partial<PiBridgeState>) {
    if (this.disposed) {
      return;
    }
    this.state = { ...this.state, ...partial };
    this.options.onState(this.state);
  }
}
