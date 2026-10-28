/**
 * Tracked-file listing for `@` autocomplete in the Composer.
 *
 * Contract: `list_files` answers from tracked files in Pi's `cwd`, filters by
 * `query`, and caps at `limit` (client limit 200, default 50). Paths are
 * relative to Pi's cwd, exactly as `git ls-files` prints them.
 */
import { clampFileLimit } from "./protocol.ts";

export interface ExecResultLike {
  stdout: string;
  stderr: string;
  code: number;
}

export type ExecLike = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number; signal?: AbortSignal },
) => Promise<ExecResultLike>;

export async function listTrackedFiles(
  exec: ExecLike,
  options: { cwd: string; query?: unknown; limit?: unknown },
): Promise<string[]> {
  const result = await exec("git", ["ls-files", "-z"], { cwd: options.cwd, timeout: 10_000 });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ls-files exited with code ${result.code}`);
  }
  const files = result.stdout.split("\0").filter((file) => file.length > 0);
  const query = typeof options.query === "string" ? options.query.trim().toLowerCase() : "";
  const matched = query
    ? files.filter((file) => file.toLowerCase().includes(query))
    : files;
  return matched.slice(0, clampFileLimit(options.limit));
}
