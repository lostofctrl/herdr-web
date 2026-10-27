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
  lastError: string | null;
};

export const INITIAL_PI_BRIDGE_STATE: PiBridgeState = {
  status: "connecting",
  capabilities: {},
  state: null,
  catalog: null,
  dialogs: [],
  assistantMessage: null,
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
      this.rejectPending(new Error(reason || "Pi Bridge connection closed"));
      if (code === 4501) {
        this.patch({ status: "unknown-pane", lastError: reason || "unknown_pane" });
        return;
      }
      this.patch({ status: "offline", lastError: reason || `relay_closed_${code}` });
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
      return;
    }

    switch (record.type) {
      case "hello":
        this.patch({
          capabilities:
            record.capabilities && typeof record.capabilities === "object"
              ? (record.capabilities as PiCapabilities)
              : {},
        });
        return;
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
