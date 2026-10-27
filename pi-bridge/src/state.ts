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
  message?: { role?: string; content?: unknown };
}

export interface ContextLike {
  cwd: string;
  model?: ModelLike | null;
  scopedModels?: readonly { model: ModelLike }[];
  modelRegistry?: {
    getAvailable?: () => ModelLike[];
    find?: (provider: string, modelId: string) => ModelLike | undefined;
  };
  thinkingLevel?: string | null;
  sessionManager?: {
    getEntries?: () => SessionEntryLike[];
    resourceLoader?: { getSkills?: () => unknown };
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
 * Read Pi's skill catalog. Pi 1.4.0 has no public skills API, only the
 * internal `resourceLoader.getSkills()` reached through the session manager,
 * so the whole read sits behind a try/catch and the caller advertises the
 * `skills_catalog` capability accordingly.
 */
export function readSkills(context: ContextLike | null): {
  skills: CatalogEntry[];
  available: boolean;
  note?: string;
} {
  const note = "Pi did not expose a skills catalog API; showing commands only.";
  try {
    const loader = context?.sessionManager?.resourceLoader;
    const result = loader?.getSkills?.();
    const rawSkills = Array.isArray(result)
      ? result
      : result && typeof result === "object" && Array.isArray((result as { skills?: unknown }).skills)
        ? (result as { skills: unknown[] }).skills
        : null;
    if (!rawSkills) {
      return { skills: [], available: false, note };
    }
    const skills = rawSkills
      .filter(
        (skill): skill is { name: string; description?: string } =>
          Boolean(skill && typeof skill === "object" && typeof (skill as { name?: unknown }).name === "string"),
      )
      .map((skill) => ({
        name: skill.name,
        description: skill.description ?? "",
        source: "skill",
      }));
    return { skills, available: true };
  } catch {
    return { skills: [], available: false, note };
  }
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
