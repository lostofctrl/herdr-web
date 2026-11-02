import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { BridgeRuntime } from "../bridge";
import { createFileApi, FileApiError, type FileBindingSnapshot, type FileWatchEvent } from "./fileApi";
import type { FileBinding } from "./fileTabs";
import type { FileDraft, FileSaveResult } from "./FileEditor";
import { FileWorkspace, type FileMentionProps, type FileWorkspaceDraft } from "./FileWorkspace";
import { watchWithRetry } from "./fileWatchRetry";

/** A workspace never follows the globally selected bridge: its owner and binding are fixed. */
export function BoundFileWorkspace({ runtime, binding, drafts, onDraftChange, onPathRenamed, mention, storageWarning }: {
  runtime: BridgeRuntime;
  binding: FileBinding;
  drafts: Readonly<Record<string, FileWorkspaceDraft | undefined>>;
  onDraftChange: (path: string, draft: FileDraft) => void;
  onPathRenamed?: (from: string, to: string) => void;
  mention?: FileMentionProps;
  storageWarning?: string;
}) {
  const bindingKey = JSON.stringify([binding.bridgeId, binding.connectionKey, binding.bridgeIdentity, binding.rootIdentity, binding.bindingIdentity]);
  const baseUrl = new URL(runtime.httpUrl("/"), window.location.href).toString();
  const current = useRef<FileBindingSnapshot | null>(null);
  const snapshot = useMemo<FileBindingSnapshot>(() => ({
    identity: { bridge_id: binding.bridgeIdentity, root_id: binding.rootIdentity, binding_id: binding.bindingIdentity },
    generation: 0,
  }), [binding.bridgeIdentity, binding.rootIdentity, binding.bindingIdentity, bindingKey, baseUrl]);
  useLayoutEffect(() => {
    current.current = snapshot;
    return () => { current.current = null; };
  }, [snapshot, bindingKey, baseUrl]);
  const api = useMemo(() => createFileApi(baseUrl, () => current.current === snapshot ? snapshot : null), [baseUrl, snapshot]);
  const list = useCallback(async (path: string) => (await api.request(snapshot, { type: "list", path })).entries, [api, snapshot]);
  const read = useCallback((path: string) => api.request(snapshot, { type: "read", path }), [api, snapshot]);
  const save = useCallback(async (path: string, content: string, revision: string): Promise<FileSaveResult> => {
    try {
      const result = await api.request(snapshot, { type: "save", path, content, revision });
      return { ok: true, revision: result.revision };
    } catch (error) {
      return { ok: false, kind: error instanceof FileApiError && error.code === "conflict" ? "conflict" : "error", message: error instanceof Error ? error.message : "Save failed" };
    }
  }, [api, snapshot]);
  const createFile = useCallback(async (path: string) => { await api.request(snapshot, { type: "create_file", path }); }, [api, snapshot]);
  const createDirectory = useCallback(async (path: string) => { await api.request(snapshot, { type: "create_directory", path }); }, [api, snapshot]);
  const rename = useCallback(async (path: string, destination: string) => { await api.request(snapshot, { type: "rename", path, destination }); }, [api, snapshot]);
  const copy = useCallback(async (path: string, destination: string) => { await api.request(snapshot, { type: "copy", path, destination }); }, [api, snapshot]);
  const search = useCallback(async (query: string, content: boolean) => {
    const result = await api.request(snapshot, { type: "search", query, content });
    return result.results;
  }, [api, snapshot]);
  const watch = useCallback((path: string, onEvent: (event: FileWatchEvent) => void) => watchWithRetry({
    start: (signal, deliver) => api.watch(snapshot, path, deliver, signal),
    onEvent,
    // Covers the bridge's bounded stream lifetime and transient disconnects; a
    // reconnect is a full resync, so a consumer must not treat it as incremental.
    onStop: () => undefined,
  }), [api, snapshot]);
  const remove = useCallback(async (path: string, recursive = false) => {
    await api.request(snapshot, { type: "remove", path, recursive });
  }, [api, snapshot]);
  const download = useCallback((path: string) => api.download(snapshot, path), [api, snapshot]);
  const upload = useCallback(async (path: string, file: Blob) => { await api.upload(snapshot, path, file); }, [api, snapshot]);
  return <>
    <p role="note" className="file-workspace-note">File access is not authenticated: every client allowed by this bridge can read and change its configured root. Use only trusted clients and networks. Drafts are stored locally and may contain sensitive content.</p>
    <p role="note" className="file-workspace-note">Saving replaces the file and can lose hidden trusted.* filesystem attributes, potentially changing security or filesystem behavior.</p>
    <FileWorkspace bindingKey={bindingKey} list={list} read={read} save={save} drafts={drafts} onDraftChange={onDraftChange}
      createFile={createFile} createDirectory={createDirectory} rename={rename} copy={copy}
      download={download} upload={upload} remove={remove} mention={mention} watch={watch} search={search}
      onPathRenamed={onPathRenamed} storageWarning={storageWarning} />
  </>;
}
