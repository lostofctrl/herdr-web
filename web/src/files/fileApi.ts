/** Provisional JSON contract only; the bridge must independently enforce root containment. */
export interface FileIdentity {
  bridge_id: string;
  root_id: string;
  binding_id: string;
}

/** Increment generation whenever the owning connection/capability is invalidated, even if it returns. */
export interface FileBindingSnapshot {
  identity: FileIdentity;
  generation: number;
}

export type FileOperation =
  | { type: "list"; path: string }
  | { type: "read"; path: string }
  | { type: "save"; path: string; content: string; revision: string }
  | { type: "create_file" | "create_directory"; path: string }
  | { type: "remove"; path: string; recursive?: boolean }
  | { type: "copy" | "rename"; path: string; destination: string };

export interface FileResults {
  list: { entries: (
    | { name: string; kind: "file" | "directory" }
    | { name: string; kind: "symlink"; resolved_kind?: "file" | "directory" }
  )[] };
  read: { content: string; revision: string };
  save: { revision: string };
  create_file: Record<string, never>;
  create_directory: Record<string, never>;
  rename: Record<string, never>;
  copy: Record<string, never>;
  remove: Record<string, never>;
}

export class FileApiError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "FileApiError";
    this.code = code;
    this.status = status;
  }
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validIdentity(value: unknown): value is FileIdentity {
  return isRecord(value) && [value.bridge_id, value.root_id, value.binding_id]
    .every((part) => typeof part === "string" && part.trim().length > 0);
}

function sameIdentity(a: FileIdentity, b: unknown): boolean {
  return validIdentity(b) && a.bridge_id === b.bridge_id && a.root_id === b.root_id && a.binding_id === b.binding_id;
}

function validPath(path: unknown, rootAllowed: boolean): boolean {
  // Paths are JSON-decoded literals, not URLs; '%' and backslash are ordinary Linux names.
  if (typeof path !== "string" || !path || path.includes("\0")) return false;
  if (path === ".") return rootAllowed;
  return path.split("/").every((component) => component !== "" && component !== "." && component !== "..");
}

function validResult(type: FileOperation["type"], result: unknown): boolean {
  if ((type === "create_file" || type === "create_directory" || type === "rename" || type === "copy" || type === "remove") && isRecord(result) && Object.keys(result).length === 0) {
    return true;
  }
  if (!isRecord(result)) return false;
  if (type === "list") {
    return Array.isArray(result.entries) && result.entries.every((entry: unknown) =>
      isRecord(entry) && typeof entry.name === "string" && validPath(entry.name, false) &&
      !entry.name.includes("/") && (
        ((entry.kind === "file" || entry.kind === "directory") && entry.resolved_kind === undefined) ||
        (entry.kind === "symlink" && (entry.resolved_kind === undefined || entry.resolved_kind === "file" || entry.resolved_kind === "directory"))
      ));
  }
  return typeof result.revision === "string" && (type !== "read" || typeof result.content === "string");
}

/**
 * The URL and current-binding getter belong to one bridge, never the globally selected host.
 * Each request passes its own captured capability identity and generation. The owner must
 * advance generation on every invalidation so a late response cannot survive a rebind.
 */
export function createFileApi(baseUrl: string, currentBinding: () => FileBindingSnapshot | null, fetcher: Fetch = fetch) {
  const base = new URL(baseUrl);
  if (!(["http:", "https:"].includes(base.protocol)) || base.username || base.password || base.search || base.hash) {
    throw new TypeError("Invalid bridge base URL");
  }
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/api/files`;
  const url = base.toString();

  async function request<T extends FileOperation>(binding: FileBindingSnapshot | null, operation: T): Promise<FileResults[T["type"]]> {
    if (!binding || !validIdentity(binding.identity) || !Number.isSafeInteger(binding.generation) || binding.generation < 0) {
      throw new FileApiError("binding_mismatch", "File capability is unavailable or changed");
    }
    const identity: FileIdentity = { ...binding.identity };
    const generation = binding.generation;
    const assertCurrent = () => {
      let current: FileBindingSnapshot | null;
      try { current = currentBinding(); } catch { current = null; }
      if (!current || current.generation !== generation || !sameIdentity(identity, current.identity)) {
        throw new FileApiError("binding_mismatch", "File capability is unavailable or changed");
      }
    };
    assertCurrent();
    if (!operation || !["list", "read", "save", "create_file", "create_directory", "rename", "copy", "remove"].includes(operation.type) ||
        !validPath(operation.path, operation.type === "list") ||
        ((operation.type === "rename" || operation.type === "copy") && !validPath(operation.destination, false))) {
      throw new FileApiError("invalid_path", "Invalid root-relative file path");
    }
    if (operation.type === "save" && (typeof operation.content !== "string" || typeof operation.revision !== "string")) {
      throw new FileApiError("invalid_operation", "Invalid save operation");
    }
    const operationType = operation.type;
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identity, operation }),
      });
    } catch {
      assertCurrent();
      throw new FileApiError("network_error", "File request failed");
    }
    assertCurrent();
    let body: unknown;
    try { body = await response.json(); } catch {
      assertCurrent();
      throw new FileApiError("invalid_response", "Invalid file response", response.status);
    }
    assertCurrent();
    // Admission and body limits can fail before the bridge reads an identity.
    // Accept only these status-bound errors, never an unbound result.
    if (isRecord(body) && body.identity === null && !("result" in body) && isRecord(body.error) &&
        ((response.status === 503 && body.error.code === "busy") ||
         (response.status === 413 && body.error.code === "limit_exceeded")) &&
        typeof body.error.message === "string" && body.error.message) {
      throw new FileApiError(body.error.code as string, body.error.message, response.status);
    }
    if (!isRecord(body) || !sameIdentity(identity, body.identity)) {
      throw new FileApiError("binding_mismatch", "File response identity does not match", response.status);
    }
    if ("error" in body) {
      if (!("result" in body) && isRecord(body.error) && typeof body.error.code === "string" && body.error.code &&
          typeof body.error.message === "string" && body.error.message) {
        throw new FileApiError(body.error.code, body.error.message, response.status);
      }
      throw new FileApiError("invalid_response", "Invalid file error response", response.status);
    }
    if (!response.ok || !validResult(operationType, body.result)) {
      throw new FileApiError("invalid_response", "Invalid file response", response.status);
    }
    return body.result as FileResults[T["type"]];
  }

  return { request };
}
