import { apiErrorMessage, type BridgeHttpUrl } from "../../bridgeApi";

export const PI_SIDE_PANEL_BUILTINS = ["abort", "compact", "new-session", "resume", "chat-log"] as const;
export const PI_SIDE_PANEL_ICONS = ["circle-stop", "archive", "plus", "history", "message-square-text", "star", "zap", "terminal", "code", "bookmark", "play", "send"] as const;
export type PiSidePanelBuiltin = typeof PI_SIDE_PANEL_BUILTINS[number];
export type PiSidePanelIcon = { type: "lucide"; name: typeof PI_SIDE_PANEL_ICONS[number] } | { type: "glyph"; text: string };
export type PiSidePanelAction = { type: "builtin"; id: PiSidePanelBuiltin } | { type: "prompt"; text: string; delivery: "insert" | "send" };
export type PiSidePanelButton = { id: string; title: string; icon: PiSidePanelIcon; action: PiSidePanelAction };
export type PiSidePanelButtons = { schema_version: 1; revision: number; buttons: PiSidePanelButton[]; pinned: string[] };

export function defaultPiSidePanelButtons(): PiSidePanelButtons {
  return { schema_version: 1, revision: 0, buttons: [], pinned: [...PI_SIDE_PANEL_BUILTINS] };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown, max: number, prompt = false): value is string {
  return typeof value === "string" && value.trim().length > 0 && (prompt ? new TextEncoder().encode(value).length : Array.from(value).length) <= max &&
    // The control ranges are intentionally rejected at this input boundary.
    // eslint-disable-next-line no-control-regex
    !(prompt ? /[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u : /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u).test(value);
}
function includes<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function validButton(value: unknown): value is PiSidePanelButton {
  if (!record(value) || !keys(value, ["id", "title", "icon", "action"]) || typeof value.id !== "string" || value.id.length > 128 || !/^custom-[a-zA-Z0-9_-]+$/u.test(value.id) || !text(value.title, 80) || !record(value.icon) || !record(value.action)) return false;
  const icon = value.icon;
  const action = value.action;
  return ((icon.type === "lucide" && keys(icon, ["type", "name"]) && includes(PI_SIDE_PANEL_ICONS, icon.name)) || (icon.type === "glyph" && keys(icon, ["type", "text"]) && text(icon.text, 16))) &&
    ((action.type === "builtin" && keys(action, ["type", "id"]) && includes(PI_SIDE_PANEL_BUILTINS, action.id)) || (action.type === "prompt" && keys(action, ["type", "text", "delivery"]) && text(action.text, 8192, true) && (action.delivery === "insert" || action.delivery === "send")));
}
export function parsePiSidePanelButtons(value: unknown): PiSidePanelButtons {
  if (!record(value) || !keys(value, ["schema_version", "revision", "buttons", "pinned"]) || value.schema_version !== 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !Array.isArray(value.buttons) || value.buttons.length > 64 || !value.buttons.every(validButton) || !Array.isArray(value.pinned)) throw new Error("Invalid side panel buttons state");
  const buttons = value.buttons as PiSidePanelButton[];
  const ids = new Set<string>(PI_SIDE_PANEL_BUILTINS);
  for (const button of buttons) {
    if (ids.has(button.id)) throw new Error("Invalid side panel buttons state");
    ids.add(button.id);
  }
  const pins = new Set<string>();
  for (const pin of value.pinned) {
    if (typeof pin !== "string" || !ids.has(pin) || pins.has(pin)) throw new Error("Invalid side panel buttons state");
    pins.add(pin);
  }
  return { schema_version: 1, revision: value.revision as number, buttons, pinned: value.pinned as string[] };
}

export class PiSidePanelButtonsConflict extends Error {
  constructor() { super("Side panel buttons have changed"); }
}
const path = "/api/pi-sidepanel-buttons";
async function parseResponse(response: Response): Promise<PiSidePanelButtons> {
  if (response.status === 409) throw new PiSidePanelButtonsConflict();
  if (!response.ok) throw new Error((await apiErrorMessage(response)) ?? `Side panel buttons request failed: ${response.status}`);
  return parsePiSidePanelButtons(await response.json());
}
export async function fetchPiSidePanelButtons(httpUrl: BridgeHttpUrl): Promise<PiSidePanelButtons> {
  return parseResponse(await fetch(httpUrl(path)));
}
export async function putPiSidePanelButtons(httpUrl: BridgeHttpUrl, state: PiSidePanelButtons): Promise<PiSidePanelButtons> {
  const valid = parsePiSidePanelButtons(state);
  return parseResponse(await fetch(httpUrl(path), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(valid) }));
}
