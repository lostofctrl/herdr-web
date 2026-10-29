/**
 * Pi State derivation from the extension context.
 *
 * Only real Pi surfaces are read: `ctx.model`, `ctx.scopedModels`,
 * `ctx.modelRegistry.getAvailable()`, `ctx.thinkingLevel`, `ctx.cwd` and
 * `ctx.sessionManager.getEntries()` (dist/core/extensions/types.d.ts:213-250).
 */
import type { CatalogEntry, CatalogPayload, ModelOption, ModelRef } from "./protocol.ts";
import { MODEL_LIMIT, THINKING_LEVELS } from "./protocol.ts";

export interface ModelLike {
  id: string;
  name?: string;
  provider: string;
  thinkingLevelMap?: Record<string, unknown> | null;
}

export interface SessionEntryLike {
  type?: string;
  message?: { role?: string; content?: unknown; stopReason?: string };
}

export interface ContextLike {
  cwd: string;
  mode?: string;
  hasUI?: boolean;
  ui?: import("./dialogs.ts").SharedUI;
  model?: ModelLike | null;
  scopedModels?: readonly { model: ModelLike }[];
  modelRegistry?: {
    getAvailable?: () => ModelLike[];
    find?: (provider: string, modelId: string) => ModelLike | undefined;
  };
  thinkingLevel?: string | null;
  sessionManager?: {
    getEntries?: () => SessionEntryLike[];
    getBranch?: () => SessionEntryLike[];
    getSessionId?: () => string;
    getLeafId?: () => string | null;
  };
}

export function modelRef(model: ModelLike | null | undefined): ModelRef | null {
  if (!model) {
    return null;
  }
  return { provider: String(model.provider), id: model.id };
}

export function modelOption(model: ModelLike): ModelOption {
  return {
    provider: String(model.provider),
    id: model.id,
    label: model.name ?? model.id,
  };
}

export function availableModels(context: ContextLike | null): ModelOption[] {
  if (!context) {
    return [];
  }
  const scoped = context.scopedModels ?? [];
  const models =
    scoped.length > 0
      ? scoped.map((scopedModel) => scopedModel.model)
      : (context.modelRegistry?.getAvailable?.() ?? []);
  return models.slice(0, MODEL_LIMIT).map(modelOption);
}

/**
 * Levels the current model can actually use. `thinkingLevelMap` marks a level
 * as unsupported with `null` (…/pi-ai types.d.ts:651-655); without a map every
 * level is offered and Pi rejects unsupported ones itself.
 */
export function thinkingLevelsFor(model: ModelLike | null | undefined): string[] {
  const map = model?.thinkingLevelMap;
  if (map && typeof map === "object") {
    const levels = THINKING_LEVELS.filter((level) => map[level] !== null);
    if (levels.length > 0) {
      return [...levels];
    }
  }
  return [...THINKING_LEVELS];
}

export function extractAssistantText(message: { content?: unknown } | null | undefined): string {
  const content = message?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        Boolean(
          block &&
            typeof block === "object" &&
            (block as { type?: string }).type === "text" &&
            typeof (block as { text?: unknown }).text === "string",
        ),
    )
    .map((block) => block.text)
    .join("\n");
}

/** Latest completed assistant message, as recorded in the session transcript. */
export function latestAssistantFromEntries(entries: SessionEntryLike[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      return extractAssistantText(entry.message);
    }
  }
  return null;
}

/**
 * Skills come from the public `pi.getCommands()` surface, which lists them with
 * `source: "skill"` and `name: "skill:<skill>"` (Pi 1.4.0
 * core/agent-session.js `_bindExtensionCore`). The bridge strips the trigger
 * prefix so the catalog names the skill; the Composer still inserts `/skill:<name>`.
 * A host without `getCommands()` cannot report skills at all.
 */
export function skillsFromCommands(commands: readonly { name: string; description?: string; source: string }[] | null): {
  skills: CatalogEntry[];
  available: boolean;
  note?: string;
} {
  if (!commands) {
    return {
      skills: [],
      available: false,
      note: "Pi did not expose getCommands(); showing commands only.",
    };
  }
  return {
    skills: commands
      .filter((command) => command.source === "skill")
      .map((command) => ({
        name: command.name.replace(/^skill:/, ""),
        description: command.description ?? "",
        source: "skill",
      })),
    available: true,
  };
}

export function buildCatalog(
  commands: readonly { name: string; description?: string; source: string }[] | undefined,
  skills: CatalogEntry[],
  skillsNote?: string,
): CatalogPayload {
  const entries: CatalogEntry[] = (commands ?? [])
    .filter((command) => command.source !== "skill")
    .map((command) => ({
      name: command.name,
      description: command.description ?? "",
      source: command.source,
    }));
  return {
    commands: entries,
    skills,
    ...(skillsNote ? { skills_note: skillsNote } : {}),
  };
}
