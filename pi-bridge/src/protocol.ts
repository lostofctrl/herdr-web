/**
 * Versioned JSONL protocol shared by the Pi Bridge and herdr-web.
 *
 * Contract: docs/pi-mode-protocol.md (version 1). One UTF-8 JSON object per
 * line, no framing beyond `\n`. Records are capped at 1 MiB in both
 * directions. See docs/adr/0001-pi-mode-terminal-mirror-plus-extension-bridge.md
 * for the transport decision and GLOSSARY.md for the Pi State vocabulary.
 */

export const PROTOCOL_VERSION = 1;
export const MAX_RECORD_BYTES = 1024 * 1024;

export const DEFAULT_FILE_LIMIT = 50;
export const MAX_FILE_LIMIT = 200;
export const MODEL_LIMIT = 200;

/** `ThinkingLevel` from @earendil-works/pi-agent-core (dist/types.d.ts:300). */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type BridgeBusy = "idle" | "busy" | "dialog";

export interface ModelRef {
  provider: string;
  id: string;
}

export interface ModelOption extends ModelRef {
  label: string;
}

export interface PiStatePayload {
  busy: BridgeBusy;
  model: ModelRef | null;
  thinking_level: string | null;
  models: ModelOption[];
  thinking_levels: string[];
  cwd: string;
}

export interface CatalogEntry {
  name: string;
  description: string;
  source: string;
}

export interface CatalogPayload {
  commands: CatalogEntry[];
  skills: CatalogEntry[];
  /** Present when the skill catalog could not be read from a supported Pi API. */
  skills_note?: string;
}

/**
 * Feature switches advertised by `hello`. A client hides a feature whose
 * capability is false or absent. `generic_dialogs` stays false until the
 * Native Card dialog wrapping from ADR 0002 is installed; `ask_user_question`
 * question dialogs are relayed independently of it.
 */
export interface BridgeCapabilities {
  generic_dialogs: boolean;
  assistant_message: boolean;
  list_files: boolean;
  skills_catalog: boolean;
  conversation_context: boolean;
}

export interface BridgeError {
  /** Plain-English reason, as required by the protocol. */
  error: string;
}

export function okResponse(id: string, result: unknown) {
  return { type: "response" as const, id, ok: true as const, result };
}

export function errorResponse(id: string, error: string) {
  return { type: "response" as const, id, ok: false as const, error };
}

export function clampFileLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_FILE_LIMIT;
  }
  return Math.min(MAX_FILE_LIMIT, Math.max(1, Math.floor(value)));
}

export function recordByteLength(record: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(record), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
