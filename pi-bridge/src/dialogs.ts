/** ADR 0002: mutate the runner's shared ctx.ui, not a per-extension context. */
export interface DialogOptions {
  signal?: AbortSignal;
  timeout?: number;
}

export interface SharedUI {
  select(title: string, options: string[], opts?: DialogOptions): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: DialogOptions): Promise<boolean>;
  input(title: string, placeholder?: string, opts?: DialogOptions): Promise<string | undefined>;
  notify?(message: string, type?: "warning"): void;
}

export interface GenericDialog {
  id: string;
  kind: "select" | "confirm" | "input";
  title: string;
  message: string;
  options: { label: string }[];
  placeholder?: string;
  timeout_ms: number | null;
}

type Resolution = "answered" | "cancelled" | "terminal" | "timeout";
const kinds = ["select", "confirm", "input"] as const;

export function createGenericDialogs(
  opened: (dialog: GenericDialog) => void,
  closed: (id: string, resolution: Resolution) => void,
) {
  let sequence = 0;
  let restore: (() => void) | null = null;
  let installedUI: SharedUI | null = null;
  const pending = new Map<string, {
    dialog: GenericDialog;
    started: number;
    finish: (value: string | boolean | undefined, resolution: Resolution) => void;
  }>();

  function wrap(kind: GenericDialog["kind"], original: (...args: any[]) => Promise<any>, ui: SharedUI) {
    return (title: string, argument?: string | string[], opts?: DialogOptions) => {
      const fallback = kind === "confirm" ? false : undefined;
      const controller = new AbortController();
      const signal = opts?.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
      if (signal.aborted) return Promise.resolve(fallback);
      const started = Date.now();
      const timeout = typeof opts?.timeout === "number" && Number.isFinite(opts.timeout) && opts.timeout > 0
        ? opts.timeout : null;
      const dialog: GenericDialog = {
        id: `generic-${++sequence}`,
        kind, title, message: kind === "confirm" ? String(argument ?? "") : "",
        options: kind === "select" && Array.isArray(argument) ? argument.map((label) => ({ label })) : [],
        ...(kind === "input" ? { placeholder: String(argument ?? "") } : {}),
        timeout_ms: timeout,
      };
      return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = (resolution: Resolution) => {
          settled = true;
          pending.delete(dialog.id);
          signal.removeEventListener("abort", onAbort);
          // Claim the winner before aborting: Pi's abort callback may resolve synchronously.
          controller.abort();
          closed(dialog.id, resolution);
        };
        const finish = (value: string | boolean | undefined, resolution: Resolution) => {
          if (settled) return;
          cleanup(resolution);
          resolve(value);
        };
        const onAbort = () => finish(fallback, "cancelled");
        signal.addEventListener("abort", onAbort, { once: true });
        pending.set(dialog.id, { dialog, started, finish });
        opened(dialog);
        try {
          Promise.resolve(original.call(ui, title, argument, { ...opts, signal })).then(
            (value) => finish(value, timeout !== null && Date.now() - started >= timeout && value === fallback
              ? "timeout" : "terminal"),
            (error) => { if (!settled) { cleanup("terminal"); reject(error); } },
          );
        } catch (error) {
          if (!settled) { cleanup("terminal"); reject(error); }
        }
      });
    };
  }

  function install(ui: SharedUI | undefined): boolean {
    if (ui && installedUI === ui) return kinds.every((kind) => ui[kind] === wrappers?.[kind]);
    restore?.();
    restore = null;
    installedUI = null;
    if (!ui || !kinds.every((kind) => typeof ui[kind] === "function")) return false;
    const originals = Object.fromEntries(kinds.map((kind) => [kind, Object.getOwnPropertyDescriptor(ui, kind)]));
    const next = Object.fromEntries(kinds.map((kind) => [kind, wrap(kind, ui[kind], ui)])) as SharedUI;
    const rollback = () => {
      for (const kind of kinds) {
        if (ui[kind] !== next[kind]) continue;
        const descriptor = originals[kind];
        if (descriptor) Object.defineProperty(ui, kind, descriptor);
        else delete (ui as unknown as Record<string, unknown>)[kind];
      }
    };
    try {
      for (const kind of kinds) ui[kind] = next[kind] as any;
      // Read back through ctx.ui's shared object before advertising support.
      if (!kinds.every((kind) => ui[kind] === next[kind])) throw new Error("shared UI wrap did not take effect");
      wrappers = next;
      installedUI = ui;
      restore = rollback;
      return true;
    } catch {
      rollback();
      return false;
    }
  }
  let wrappers: SharedUI | null = null;

  return {
    install,
    snapshot: () => [...pending.values()].map(({ dialog, started }) => ({
      ...dialog,
      timeout_ms: dialog.timeout_ms === null ? null : Math.max(0, dialog.timeout_ms - (Date.now() - started)),
    })),
    answer(id: string, value: unknown, cancel: boolean): boolean {
      const entry = pending.get(id);
      if (!entry) return false;
      const { dialog } = entry;
      if (!cancel && !(dialog.kind === "confirm" ? typeof value === "boolean"
        : typeof value === "string" && (dialog.kind === "input" || dialog.options.some((option) => option.label === value)))) return false;
      entry.finish(cancel ? (dialog.kind === "confirm" ? false : undefined) : value as string | boolean,
        cancel ? "cancelled" : "answered");
      return true;
    },
    stop() {
      for (const entry of pending.values()) entry.finish(entry.dialog.kind === "confirm" ? false : undefined, "cancelled");
      restore?.();
      restore = null;
      installedUI = null;
    },
  };
}
