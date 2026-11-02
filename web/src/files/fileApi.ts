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
  | { type: "copy" | "rename"; path: string; destination: string }
  | { type: "search"; query: string; content?: boolean; limit?: number }
  | { type: "watch"; path: string };

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
  search: { results: { path: string; line?: number }[] };
  watch: Record<string, never>;
}

export type FileWatchEvent = { kind: "change"; name: string } | { kind: "overflow" };

/** Parses one server-sent-event block; keepalive comments yield nothing. */
function parseWatchBlock(block: string): FileWatchEvent | null {
  let event = "message";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event: ")) event = line.slice(7).trim();
    else if (line.startsWith("data: ")) data += line.slice(6);
  }
  if (event === "overflow") return { kind: "overflow" };
  if (event !== "change") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return isRecord(parsed) && typeof parsed.name === "string" && parsed.name
      ? { kind: "change", name: parsed.name }
      : null;
  } catch {
    return null;
  }
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
  if (type === "search") {
    return Array.isArray(result.results) && result.results.every((hit: unknown) =>
      isRecord(hit) && typeof hit.path === "string" && validPath(hit.path, false) &&
      (hit.line === undefined || (typeof hit.line === "number" && Number.isInteger(hit.line) && hit.line > 0)));
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
  const route = (suffix: string) => `${url}${suffix}`;
  const uploadMagic = "herdr-file-upload-1\n";

  function assertBound(binding: FileBindingSnapshot | null): FileBindingSnapshot {
    if (!binding || !validIdentity(binding.identity) || !Number.isSafeInteger(binding.generation) || binding.generation < 0) {
      throw new FileApiError("binding_mismatch", "File capability is unavailable or changed");
    }
    let current: FileBindingSnapshot | null;
    try { current = currentBinding(); } catch { current = null; }
    if (!current || current.generation !== binding.generation || !sameIdentity(binding.identity, current.identity)) {
      throw new FileApiError("binding_mismatch", "File capability is unavailable or changed");
    }
    return binding;
  }

  /** Re-checks that a stream still belongs to the live binding before each delivered event. */
  function assertStillBound(binding: FileBindingSnapshot): void {
    let current: FileBindingSnapshot | null;
    try { current = currentBinding(); } catch { current = null; }
    if (!current || current.generation !== binding.generation || !sameIdentity(binding.identity, current.identity)) {
      throw new FileApiError("binding_mismatch", "File capability is unavailable or changed");
    }
  }

  /** Structured error shared by the JSON, download and upload routes. */
  async function readError(response: Response, identity: FileIdentity): Promise<FileApiError> {
    let body: unknown;
    try { body = await response.json(); } catch {
      return new FileApiError("invalid_response", "Invalid file response", response.status);
    }
    if (isRecord(body) && body.identity === null && !("result" in body) && isRecord(body.error) &&
        ((response.status === 503 && body.error.code === "busy") ||
         (response.status === 413 && body.error.code === "limit_exceeded")) &&
        typeof body.error.message === "string" && body.error.message) {
      return new FileApiError(body.error.code as string, body.error.message, response.status);
    }
    if (!isRecord(body) || !sameIdentity(identity, body.identity)) {
      return new FileApiError("binding_mismatch", "File response identity does not match", response.status);
    }
    if (isRecord(body.error) && typeof body.error.code === "string" && body.error.code &&
        typeof body.error.message === "string" && body.error.message) {
      return new FileApiError(body.error.code, body.error.message, response.status);
    }
    return new FileApiError("invalid_response", "Invalid file error response", response.status);
  }

  /** Downloads raw bytes; the caller decides how to present or store them. */
  async function download(binding: FileBindingSnapshot | null, path: string): Promise<Blob> {
    const bound = assertBound(binding);
    if (!validPath(path, false)) throw new FileApiError("invalid_path", "Invalid root-relative file path");
    const identity: FileIdentity = { ...bound.identity };
    const generation = bound.generation;
    let response: Response;
    try {
      response = await fetcher(route("/download"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identity, operation: { type: "download", path } }),
      });
    } catch {
      assertBound(binding);
      throw new FileApiError("network_error", "File request failed");
    }
    assertBound(binding);
    if (currentBinding()?.generation !== generation) {
      throw new FileApiError("binding_mismatch", "File capability is unavailable or changed");
    }
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || type.startsWith("application/json")) throw await readError(response, identity);
    return response.blob();
  }

  /** Uploads one file to a new root-relative path, never overwriting an existing entry. */
  async function upload(binding: FileBindingSnapshot | null, path: string, file: Blob): Promise<void> {
    const bound = assertBound(binding);
    if (!validPath(path, false)) throw new FileApiError("invalid_path", "Invalid root-relative file path");
    const identity: FileIdentity = { ...bound.identity };
    const metadata = new TextEncoder().encode(JSON.stringify({ identity, path }));
    const body = new Uint8Array(uploadMagic.length + 4 + metadata.length + file.size);
    body.set(new TextEncoder().encode(uploadMagic), 0);
    new DataView(body.buffer).setUint32(uploadMagic.length, metadata.length, false);
    body.set(metadata, uploadMagic.length + 4);
    body.set(new Uint8Array(await file.arrayBuffer()), uploadMagic.length + 4 + metadata.length);
    let response: Response;
    try {
      response = await fetcher(route("/upload"), {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body,
      });
    } catch {
      assertBound(binding);
      throw new FileApiError("network_error", "File request failed");
    }
    assertBound(binding);
    let reply: unknown;
    try { reply = await response.json(); } catch {
      assertBound(binding);
      throw new FileApiError("invalid_response", "Invalid file response", response.status);
    }
    assertBound(binding);
    if (isRecord(reply) && reply.identity === null && isRecord(reply.error) &&
        ((response.status === 503 && reply.error.code === "busy") ||
         (response.status === 413 && reply.error.code === "limit_exceeded")) &&
        typeof reply.error.message === "string" && reply.error.message) {
      throw new FileApiError(reply.error.code as string, reply.error.message, response.status);
    }
    if (!isRecord(reply) || !sameIdentity(identity, reply.identity)) {
      throw new FileApiError("binding_mismatch", "File response identity does not match", response.status);
    }
    if ("error" in reply) {
      if (isRecord(reply.error) && typeof reply.error.code === "string" && reply.error.code &&
          typeof reply.error.message === "string" && reply.error.message) {
        throw new FileApiError(reply.error.code, reply.error.message, response.status);
      }
      throw new FileApiError("invalid_response", "Invalid file error response", response.status);
    }
    if (!response.ok || !isRecord(reply.result) || Object.keys(reply.result).length > 0) {
      throw new FileApiError("invalid_response", "Invalid file response", response.status);
    }
  }

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
    if (!operation || !["list", "read", "save", "create_file", "create_directory", "rename", "copy", "remove", "search", "watch"].includes(operation.type)) {
      throw new FileApiError("invalid_path", "Invalid root-relative file path");
    }
    if (operation.type === "search") {
      if (typeof operation.query !== "string" || !operation.query.trim().length) {
        throw new FileApiError("invalid_path", "Invalid search query");
      }
    } else if (!validPath(operation.path, operation.type === "list") ||
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

  /**
   * Streams change hints for one file until `signal` aborts or the bridge closes
   * the stream. Every hint is advisory: callers must resynchronize, and an
   * `overflow` hint means earlier changes may have been dropped entirely.
   */
  async function watch(
    binding: FileBindingSnapshot,
    path: string,
    onEvent: (event: FileWatchEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const { identity } = assertBound(binding);
    if (!validPath(path, false)) throw new FileApiError("invalid_path", "Invalid root-relative file path");
    let response: Response;
    try {
      response = await fetcher(route("/watch"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identity, path }),
        signal,
      });
    } catch (error) {
      if (signal.aborted) return;
      throw new FileApiError("network_error", error instanceof Error ? error.message : "File watch failed");
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !response.body || !contentType.startsWith("text/event-stream")) {
      const body: unknown = await response.json().catch(() => null);
      const message = isRecord(body) && isRecord(body.error) && typeof body.error.message === "string"
        ? body.error.message
        : "File watch failed";
      throw new FileApiError(isRecord(body) && isRecord(body.error) && typeof body.error.code === "string" ? body.error.code : "invalid_response", message, response.status);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = parseWatchBlock(block);
          if (event) {
            assertStillBound(binding);
            onEvent(event);
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  return { request, download, upload, watch };
}
