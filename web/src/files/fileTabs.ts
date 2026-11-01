/** Persistent identities and the currently live file-service binding. */
export interface FileBinding {
  bridgeId: string;
  connectionKey: string;
  bridgeIdentity: string;
  rootIdentity: string;
  bindingIdentity: string;
}

/**
 * Dirty drafts need both base strings for a conditional save. Version-1 drafts
 * without them load as needsRecovery and must be reviewed, not saved against a
 * freshly fetched revision. Clean tabs carry neither base nor recovery marker.
 * The optional fields retain compatibility with legacy callers; readers and
 * partitionFileTabs mark legacy dirty drafts before exposing them as usable.
 */
export interface FileTab {
  binding: FileBinding;
  path: string;
  draft: string;
  dirty: boolean;
  baseContent?: string;
  baseRevision?: string;
  needsRecovery?: true;
}

export interface FileTabStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** A getter lets callers surface localStorage access errors without touching browser globals here. */
export type FileTabStorageAccess = FileTabStorage | null | (() => FileTabStorage | null);

type ReadResult = { ok: true; tabs: FileTab[] } | { ok: false; error: "invalid-data" | "storage-unavailable" | "storage-read-failed" };
type SaveResult = { ok: true; tabs: FileTab[] } | { ok: false; error: "invalid-data" | "storage-unavailable" | "storage-write-failed"; tabs: FileTab[] };

const STORAGE_KEY = "herdr.files.tabs.v1";

/** JSON tuple encoding prevents delimiter and escape collisions. */
export function fileTabKey(tab: Pick<FileTab, "binding" | "path">): string {
  const { bridgeId, connectionKey, bridgeIdentity, rootIdentity } = tab.binding;
  return JSON.stringify([bridgeId, connectionKey, bridgeIdentity, rootIdentity, tab.path]);
}

/** Mismatched tabs are returned separately, never reopened under the current binding. */
export function partitionFileTabs(tabs: readonly FileTab[], binding: FileBinding, rootConfirmed = false): { matching: FileTab[]; recovery: FileTab[] } {
  const matching: FileTab[] = [];
  const recovery: FileTab[] = [];
  for (const original of tabs) {
    const tab = markLegacyRecovery(original);
    const saved = tab.binding;
    const same = saved.bridgeId === binding.bridgeId && saved.connectionKey === binding.connectionKey &&
      saved.bridgeIdentity === binding.bridgeIdentity && saved.rootIdentity === binding.rootIdentity;
    const bindingAccepted = saved.bindingIdentity === binding.bindingIdentity || rootConfirmed;
    if (same && bindingAccepted && !tab.needsRecovery) {
      matching.push(saved.bindingIdentity === binding.bindingIdentity ? tab : { ...tab, binding });
    } else {
      recovery.push(tab);
    }
  }
  return { matching, recovery };
}

export function serializeFileTabs(tabs: readonly FileTab[]): string {
  return JSON.stringify({ version: 1, tabs });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTab(value: unknown): value is FileTab {
  if (!isRecord(value) || !isRecord(value.binding)) return false;
  const { binding } = value;
  const hasContent = Object.hasOwn(value, "baseContent");
  const hasRevision = Object.hasOwn(value, "baseRevision");
  const hasRecovery = Object.hasOwn(value, "needsRecovery");
  const validMetadata = hasContent || hasRevision
    ? value.dirty === true && typeof value.baseContent === "string" && typeof value.baseRevision === "string" && !hasRecovery
    : !hasRecovery || (value.dirty === true && value.needsRecovery === true);
  return [binding.bridgeId, binding.connectionKey, binding.bridgeIdentity, binding.rootIdentity, binding.bindingIdentity, value.path]
    .every((part) => typeof part === "string" && part.length > 0) &&
    typeof value.draft === "string" && typeof value.dirty === "boolean" && validMetadata;
}

function markLegacyRecovery(tab: FileTab): FileTab {
  return tab.dirty && (tab.needsRecovery || typeof tab.baseContent !== "string" || typeof tab.baseRevision !== "string")
    ? { ...tab, needsRecovery: true }
    : tab;
}

export function deserializeFileTabs(raw: string): ReadResult {
  try {
    const data: unknown = JSON.parse(raw);
    if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.tabs) || !data.tabs.every(isTab)) {
      return { ok: false, error: "invalid-data" };
    }
    const tabs: FileTab[] = data.tabs;
    if (new Set(tabs.map(fileTabKey)).size !== tabs.length) return { ok: false, error: "invalid-data" };
    return { ok: true, tabs: tabs.map(markLegacyRecovery) };
  } catch {
    return { ok: false, error: "invalid-data" };
  }
}

function getStorage(access: FileTabStorageAccess): FileTabStorage | null {
  return typeof access === "function" ? access() : access;
}

export function loadFileTabs(access: FileTabStorageAccess): ReadResult {
  try {
    const storage = getStorage(access);
    if (!storage) return { ok: false, error: "storage-unavailable" };
    const raw = storage.getItem(STORAGE_KEY);
    return raw === null ? { ok: true, tabs: [] } : deserializeFileTabs(raw);
  } catch {
    return { ok: false, error: "storage-read-failed" };
  }
}

/** The caller owns tabs and must retain them, including recovery tabs, after every result. */
export function saveFileTabs(access: FileTabStorageAccess, tabs: FileTab[]): SaveResult {
  let raw: string;
  try {
    raw = serializeFileTabs(tabs);
    if (!deserializeFileTabs(raw).ok) return { ok: false, error: "invalid-data", tabs };
  } catch {
    return { ok: false, error: "invalid-data", tabs };
  }
  try {
    const storage = getStorage(access);
    if (!storage) return { ok: false, error: "storage-unavailable", tabs };
    storage.setItem(STORAGE_KEY, raw);
    return { ok: true, tabs };
  } catch {
    return { ok: false, error: "storage-write-failed", tabs };
  }
}
