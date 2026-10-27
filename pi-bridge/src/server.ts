/**
 * Per-pane Unix socket JSONL server.
 *
 * Lifecycle: created on `session_start`, replaces a stale socket file left by a
 * crashed Pi, refuses to steal a socket from a live bridge, and unlinks the
 * socket on `session_shutdown`. The socket directory is 0700 and the socket
 * 0600.
 */
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import path from "node:path";

import { MAX_RECORD_BYTES, errorResponse } from "./protocol.ts";

export type RecordSender = (record: unknown) => void;

export interface BridgeServerOptions {
  socketPath: string;
  /** Handle one request line; may respond through `reply` later. */
  onLine: (line: string, reply: RecordSender) => void | Promise<void>;
  /** Called for every new client so the bridge can send hello + snapshot. */
  onClientConnect?: (send: RecordSender) => void;
  log?: (message: string) => void;
}

export interface BridgeServer {
  readonly socketPath: string;
  isRunning(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  broadcast(record: unknown): void;
  clientCount(): number;
}

export class BridgeSocketInUseError extends Error {
  constructor(socketPath: string) {
    super(`another Pi Bridge is already listening on ${socketPath}`);
    this.name = "BridgeSocketInUseError";
  }
}

export function createBridgeServer(options: BridgeServerOptions): BridgeServer {
  const clients = new Set<Socket>();
  const log = options.log ?? (() => {});
  let server: Server | null = null;
  let running = false;

  function safeWrite(socket: Socket, record: unknown): void {
    if (socket.destroyed) {
      return;
    }
    let line: string;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch {
      return;
    }
    if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
      log("refusing to send a record over the 1 MiB protocol cap");
      return;
    }
    socket.write(line);
  }

  function handleConnection(socket: Socket): void {
    clients.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let queue: Promise<void> = Promise.resolve();
    const reply: RecordSender = (record) => safeWrite(socket, record);

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim().length > 0) {
          queue = queue
            .then(() => options.onLine(line, reply))
            .catch((error: unknown) => {
              reply(errorResponse("", error instanceof Error ? error.message : String(error)));
            });
        }
        index = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_RECORD_BYTES) {
        log("client sent a record over the 1 MiB protocol cap; closing connection");
        socket.destroy();
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      clients.delete(socket);
    });

    if (options.onClientConnect) {
      try {
        options.onClientConnect(reply);
      } catch (error) {
        log(`failed to send the initial snapshot: ${String(error)}`);
      }
    }
  }

  async function probeExisting(socketPath: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const probe = createConnection(socketPath);
      let settled = false;
      const finish = (alive: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        probe.removeAllListeners();
        probe.destroy();
        resolve(alive);
      };
      probe.setTimeout(250);
      probe.once("connect", () => finish(true));
      probe.once("timeout", () => finish(false));
      probe.once("error", () => finish(false));
    });
  }

  async function start(): Promise<void> {
    if (running || server) {
      return;
    }
    const socketPath = options.socketPath;
    await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    try {
      await chmod(path.dirname(socketPath), 0o700);
    } catch {
      // Some filesystems do not support chmod; the socket still works.
    }

    try {
      await lstat(socketPath);
      if (await probeExisting(socketPath)) {
        throw new BridgeSocketInUseError(socketPath);
      }
      await unlink(socketPath);
    } catch (error) {
      if (error instanceof BridgeSocketInUseError) {
        throw error;
      }
      // ENOENT: no stale socket to replace.
    }

    const created = createServer(handleConnection);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        created.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        created.off("error", onError);
        resolve();
      };
      created.once("error", onError);
      created.once("listening", onListening);
      created.listen(socketPath);
    });
    created.on("error", (error) => log(`pi bridge socket error: ${String(error)}`));
    try {
      await chmod(socketPath, 0o600);
    } catch {
      // Not supported on every platform.
    }
    server = created;
    running = true;
  }

  async function stop(): Promise<void> {
    const current = server;
    server = null;
    running = false;
    for (const client of clients) {
      client.destroy();
    }
    clients.clear();
    if (current) {
      await new Promise<void>((resolve) => current.close(() => resolve()));
    }
    await unlink(options.socketPath).catch(() => {});
  }

  function broadcast(record: unknown): void {
    for (const client of clients) {
      safeWrite(client, record);
    }
  }

  return {
    socketPath: options.socketPath,
    isRunning: () => running,
    start,
    stop,
    broadcast,
    clientCount: () => clients.size,
  };
}
