/** Pi Bridge protocol v1 records relayed by the herdr-web bridge (docs/pi-mode-protocol.md). */

export type PiBusy = "idle" | "busy" | "dialog";

export type PiModelRef = { provider: string; id: string };

export type PiModel = PiModelRef & { label: string };

export type PiState = {
  busy: PiBusy;
  model: PiModelRef | null;
  thinking_level: string;
  models: PiModel[];
  thinking_levels: string[];
  cwd: string;
};

export type PiCatalogEntry = { name: string; description: string; source: string };

export type PiCatalog = {
  commands: PiCatalogEntry[];
  skills: PiCatalogEntry[];
  skills_note?: string;
};

export type PiQuestionOption = {
  label: string;
  description?: string;
  preview?: string;
};

/** One `ask_user_question` question, including every option and preview. */
export type PiQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: PiQuestionOption[];
};

export type PiDialog = {
  id: string;
  kind: "question" | "select" | "confirm" | "input";
  title?: string;
  message?: string;
  questions?: PiQuestion[];
  options?: { label: string; description?: string; preview?: string }[];
  placeholder?: string;
  timeout_ms?: number | null;
};

export type PiSnapshotResult = {
  state: PiState;
  catalog: PiCatalog;
  dialogs: PiDialog[];
  assistant_message: string | null;
};

export type PiCapabilities = Record<string, boolean>;
