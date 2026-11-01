import { describe, expect, it, vi } from "vitest";
import { createFileApi, type FileBindingSnapshot, type FileOperation } from "./fileApi";

const identity = { bridge_id: "bridge-a", root_id: "root-a", binding_id: "binding-a" };
const binding: FileBindingSnapshot = { identity, generation: 1 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const success = (result: unknown, replyIdentity = identity) => json({ identity: replyIdentity, result });

describe("provisional file API", () => {
  it("posts typed list, read and save requests under the owned proxy prefix", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(success({ entries: [{ name: "a.txt", kind: "file" }] }))
      .mockResolvedValueOnce(success({ content: "hello", revision: "r1" }))
      .mockResolvedValueOnce(success({ revision: "r2" }));
    const api = createFileApi("https://example.test/bridges/server60", () => binding, fetcher);
    expect(await api.request(binding, { type: "list", path: "." })).toEqual({ entries: [{ name: "a.txt", kind: "file" }] });
    expect(await api.request(binding, { type: "read", path: "folder/a b.txt" })).toEqual({ content: "hello", revision: "r1" });
    expect(await api.request(binding, { type: "save", path: "folder/a b.txt", content: "changed", revision: "r1" })).toEqual({ revision: "r2" });
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).toBe("https://example.test/bridges/server60/api/files");
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({ "content-type": "application/json" });
      expect(JSON.parse(init.body).identity).toEqual(identity);
    }
    expect(JSON.parse(fetcher.mock.calls[2][1].body).operation).toEqual({ type: "save", path: "folder/a b.txt", content: "changed", revision: "r1" });
  });

  it("keeps separate bridge clients and identities isolated", async () => {
    const other = { identity: { bridge_id: "bridge-b", root_id: "root-b", binding_id: "binding-b" }, generation: 4 };
    const fetcher = vi.fn().mockResolvedValueOnce(success({ content: "a", revision: "1" }))
      .mockResolvedValueOnce(success({ content: "b", revision: "2" }, other.identity));
    const a = createFileApi("https://a.test/prefix/", () => binding, fetcher);
    const b = createFileApi("https://b.test/other", () => other, fetcher);
    expect(await a.request(binding, { type: "read", path: "a" })).toEqual({ content: "a", revision: "1" });
    expect(await b.request(other, { type: "read", path: "b" })).toEqual({ content: "b", revision: "2" });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["https://a.test/prefix/api/files", "https://b.test/other/api/files"]);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).identity).toEqual(other.identity);
  });

  it("surfaces a structured error only when the reply identity matches", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ identity, error: { code: "conflict", message: "File changed" } }, 409));
    const api = createFileApi("https://a.test", () => binding, fetcher);
    await expect(api.request(binding, { type: "save", path: "a", content: "x", revision: "old" }))
      .rejects.toMatchObject({ name: "FileApiError", code: "conflict", message: "File changed", status: 409 });
  });

  it("accepts literal percent and JSON-escaped names and typed symlinks", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(success({ entries: [
      { name: "%2e%2e", kind: "file" },
      { name: "safe", kind: "symlink", resolved_kind: "directory" },
      { name: "dangling", kind: "symlink" },
    ] })).mockResolvedValueOnce(success({ content: "old\n\"", revision: "old\n\"" }));
    const api = createFileApi("https://a.test", () => binding, fetcher);
    await expect(api.request(binding, { type: "list", path: "." })).resolves.toMatchObject({ entries: [
      { name: "%2e%2e", kind: "file" }, { name: "safe", kind: "symlink", resolved_kind: "directory" },
      { name: "dangling", kind: "symlink" },
    ] });
    for (const path of ["%2e%2e/quote\"\\name", "%252e%252e/x", "a/%2f/b", "bad%zz", "line\nbreak"]) {
      fetcher.mockResolvedValueOnce(success({ content: "text", revision: "text" }));
      await api.request(binding, { type: "read", path });
      expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body).operation.path).toBe(path);
    }
  });

  it("rejects absolute, traversal and malformed paths without fetching", async () => {
    const fetcher = vi.fn();
    const api = createFileApi("https://a.test", () => binding, fetcher);
    for (const path of ["", "/etc/passwd", "//host/share", "../x", "a/../b", "a/./b", "a//b", "a/", "a\u0000b"]) {
      await expect(api.request(binding, { type: "read", path })).rejects.toMatchObject({ code: "invalid_path" });
    }
    await expect(api.request(binding, { type: "read", path: "." })).rejects.toMatchObject({ code: "invalid_path" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects malformed symlink hints and surfaces service errors with a successful status", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(success({ entries: [{ name: "link", kind: "symlink", resolved_kind: "symlink" }] }))
      .mockResolvedValueOnce(success({ entries: [{ name: "file", kind: "file", resolved_kind: "directory" }] }))
      .mockResolvedValueOnce(json({ identity, error: { code: "conflict", message: "File changed" } }));
    const api = createFileApi("https://a.test", () => binding, fetcher);
    await expect(api.request(binding, { type: "list", path: "." })).rejects.toMatchObject({ code: "invalid_response" });
    await expect(api.request(binding, { type: "list", path: "." })).rejects.toMatchObject({ code: "invalid_response" });
    await expect(api.request(binding, { type: "save", path: "a", content: "x", revision: "old" }))
      .rejects.toMatchObject({ code: "conflict", message: "File changed" });
  });

  it("fails closed for absent or mismatched current identity and mismatched replies", async () => {
    const fetcher = vi.fn().mockResolvedValue(success({ content: "wrong", revision: "1" }, { ...identity, root_id: "other" }));
    let current: FileBindingSnapshot | null = null;
    const api = createFileApi("https://a.test", () => current, fetcher);
    await expect(api.request(binding, { type: "read", path: "a" })).rejects.toMatchObject({ code: "binding_mismatch" });
    current = { ...binding, identity: { ...identity, binding_id: "other" } };
    await expect(api.request(binding, { type: "read", path: "a" })).rejects.toMatchObject({ code: "binding_mismatch" });
    expect(fetcher).not.toHaveBeenCalled();
    current = binding;
    await expect(api.request(binding, { type: "read", path: "a" })).rejects.toMatchObject({ code: "binding_mismatch" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects late replies even if the same identity is rebound with a newer generation", async () => {
    let current: FileBindingSnapshot | null = binding;
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
    const api = createFileApi("https://a.test", () => current, fetcher);
    const pending = api.request(binding, { type: "read", path: "a" });
    current = { identity, generation: 2 };
    resolve(success({ content: "stale", revision: "1" }));
    await expect(pending).rejects.toMatchObject({ code: "binding_mismatch" });
  });

  it("checks the binding again after reading the response body", async () => {
    let current: FileBindingSnapshot | null = binding;
    let resolve!: (value: unknown) => void;
    const response = { ok: true, status: 200, json: () => new Promise((done) => { resolve = done; }) } as Response;
    const api = createFileApi("https://a.test", () => current, vi.fn().mockResolvedValue(response));
    const pending = api.request(binding, { type: "read", path: "a" });
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    current = null;
    resolve({ identity, result: { content: "stale", revision: "1" } });
    await expect(pending).rejects.toMatchObject({ code: "binding_mismatch" });
  });

  it("validates the reply against the operation captured at dispatch", async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
    const api = createFileApi("https://a.test", () => binding, fetcher);
    const operation: { type: "read" | "save"; path: string; content?: string; revision?: string } = { type: "read", path: "a" };
    const pending = api.request(binding, operation as { type: "read"; path: string });
    operation.type = "save";
    resolve(success({ content: "read result", revision: "1" }));
    await expect(pending).resolves.toEqual({ content: "read result", revision: "1" });
    const next = { type: "read", path: "a" } as { type: "read" | "save"; path: string };
    const invalid = api.request(binding, next as { type: "read"; path: string });
    next.type = "save";
    resolve(success({ revision: "1" }));
    await expect(invalid).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("sends confined mutation requests and validates both rename paths", async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(success({})));
    const api = createFileApi("https://a.test/prefix", () => binding, fetcher);
    for (const operation of [
      { type: "create_file", path: "dir/new" },
      { type: "create_directory", path: "dir/subdir" },
      { type: "rename", path: "dir/new", destination: "dir/moved" },
      { type: "remove", path: "dir/moved" },
      { type: "remove", path: "dir", recursive: true },
      { type: "copy", path: "dir/moved", destination: "dir/copied" },
    ]) {
      await expect(api.request(binding, operation as FileOperation)).resolves.toEqual({});
      expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body).operation).toEqual(operation);
    }
    await expect(api.request(binding, { type: "rename", path: "dir/file", destination: "../escape" } as unknown as FileOperation))
      .rejects.toMatchObject({ code: "invalid_path" });
    await expect(api.request(binding, { type: "copy", path: "dir/file", destination: "/abs" } as unknown as FileOperation))
      .rejects.toMatchObject({ code: "invalid_path" });
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it("surfaces pre-admission busy errors without accepting unbound success", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ identity: null, error: { code: "busy", message: "File service is busy" } }, 503))
      .mockResolvedValueOnce(json({ identity: null, error: { code: "limit_exceeded", message: "File request limit exceeded" } }, 413))
      .mockResolvedValueOnce(json({ identity: null, result: { content: "wrong", revision: "1" } }))
      .mockResolvedValueOnce(json({ identity: null, error: { code: "conflict", message: "File changed" } }));
    const api = createFileApi("https://a.test", () => binding, fetcher);
    await expect(api.request(binding, { type: "read", path: "a" })).rejects.toMatchObject({ code: "busy" });
    await expect(api.request(binding, { type: "read", path: "a" })).rejects.toMatchObject({ code: "limit_exceeded" });
    await expect(api.request(binding, { type: "read", path: "a" })).rejects.toMatchObject({ code: "binding_mismatch" });
    await expect(api.request(binding, { type: "read", path: "a" })).rejects.toMatchObject({ code: "binding_mismatch" });
  });

  it("rejects malformed replies and unsafe bridge base URLs", async () => {
    const api = createFileApi("https://a.test", () => binding, vi.fn().mockResolvedValue(json({ result: { content: "x", revision: "1" } })));
    await expect(api.request(binding, { type: "read", path: "a" })).rejects.toMatchObject({ code: "binding_mismatch" });
    expect(() => createFileApi("https://a.test/prefix?x=1", () => binding)).toThrow();
    expect(() => createFileApi("https://user:pass@a.test", () => binding)).toThrow();
  });
});
