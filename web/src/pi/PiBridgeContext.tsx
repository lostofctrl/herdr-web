import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { addNativeResumeHandler } from "../native";
import {
  INITIAL_PI_BRIDGE_STATE,
  PiBridgeClient,
  type PiBridgeState,
} from "./piClient";

export function piBridgeSocketUrl(
  wsUrl: (path: string, query?: URLSearchParams) => string,
  paneId: string,
) {
  return wsUrl("/ws/pi", new URLSearchParams({ pane_id: paneId }));
}

export type PiBridgeApi = PiBridgeState & {
  paneId: string;
  /** Send a dialog answer; `{cancel: true}` dismisses like Esc. */
  answerDialog: (
    dialogId: string,
    answer: { value?: unknown } | { cancel: true },
  ) => Promise<{ accepted: boolean }>;
  /** Ask Pi for tracked files under its cwd. The limit is capped at 200. */
  listFiles: (query: string, limit?: number) => Promise<{ path: string }[]>;
  setModel: (provider: string, model: string) => Promise<void>;
  setThinkingLevel: (level: string) => Promise<void>;
  /** Resend the snapshot after a reconnect or when the page resumes. */
  resync: () => void;
};

type PiBridgeContextValue = {
  paneId: string;
  api: PiBridgeApi;
};

const PiBridgeContext = createContext<PiBridgeContextValue | null>(null);

export type PiBridgeProviderProps = {
  paneId: string;
  wsUrl: (path: string, query?: URLSearchParams) => string;
  /** Changes when the bridge runtime changes, forcing a fresh relay connection. */
  connectionKey: string;
  /** Parent resume signal; every increment resyncs an online client. */
  resumeToken?: number;
  /** Pi mode connects only for the selected Pi Pane. */
  enabled?: boolean;
  children: ReactNode;
};

/**
 * Owns the single Pi relay connection for one Pi Pane. Mount it only around a
 * Pi Pane's controls; it renders its children unchanged and adds no DOM.
 */
export function PiBridgeProvider({
  paneId,
  wsUrl,
  connectionKey,
  resumeToken = 0,
  enabled = true,
  children,
}: PiBridgeProviderProps) {
  const [snapshot, setSnapshot] = useState<PiBridgeState>(INITIAL_PI_BRIDGE_STATE);
  const [client, setClient] = useState<PiBridgeClient | null>(null);
  const clientRef = useRef<PiBridgeClient | null>(null);

  useEffect(() => {
    if (!enabled) {
      clientRef.current = null;
      setClient(null);
      setSnapshot(INITIAL_PI_BRIDGE_STATE);
      return;
    }
    const next = new PiBridgeClient({
      url: () => piBridgeSocketUrl(wsUrl, paneId),
      onState: setSnapshot,
    });
    clientRef.current = next;
    setClient(next);
    next.connect();

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        next.resync();
      }
    };
    const removeNativeResume = addNativeResumeHandler(() => next.resync());
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      removeNativeResume();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (clientRef.current === next) {
        clientRef.current = null;
      }
      next.dispose();
    };
  }, [connectionKey, enabled, paneId, wsUrl]);

  useEffect(() => {
    if (resumeToken > 0) {
      clientRef.current?.resync();
    }
  }, [resumeToken]);

  const api = useMemo<PiBridgeApi | null>(() => {
    if (!enabled || !client) {
      return null;
    }
    return {
      paneId,
      ...snapshot,
      answerDialog: (dialogId, answer) => {
        const payload = "cancel" in answer
          ? { dialog_id: dialogId, cancel: true }
          : { dialog_id: dialogId, value: answer.value };
        return client.request<{ accepted: boolean }>("dialog_answer", payload);
      },
      listFiles: async (query, limit = 50) => {
        const result = await client.request<{ files?: { path: string }[] }>("list_files", {
          query,
          limit: Math.min(limit, 200),
        });
        return result.files ?? [];
      },
      setModel: async (provider, model) => {
        await client.request("set_model", { provider, model });
      },
      setThinkingLevel: async (level) => {
        await client.request("set_thinking_level", { level });
      },
      resync: () => client.resync(),
    };
  }, [client, enabled, paneId, snapshot]);

  const value = useMemo<PiBridgeContextValue | null>(
    () => (api ? { paneId, api } : null),
    [api, paneId],
  );

  return <PiBridgeContext.Provider value={value}>{children}</PiBridgeContext.Provider>;
}

/**
 * Reads the Pi mode client for `paneId`. Returns null outside a matching Pi
 * Pane provider, so non-Pi panes and disabled Pi mode stay inert.
 */
export function usePiBridge(paneId: string | null | undefined): PiBridgeApi | null {
  const context = useContext(PiBridgeContext);
  return context && paneId && context.paneId === paneId ? context.api : null;
}
