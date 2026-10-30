import { History, ImagePlus, Send, TextCursorInput, X, Square, Terminal } from "lucide-react";
import { flushSync } from "react-dom";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, KeyboardEvent, ClipboardEvent, ReactNode, RefObject, CSSProperties } from "react";

import { compositionGuardDeadline, isLateCompositionEdit } from "../commandTextFieldGuard";
import { hasOpenMenu, hasOpenModal, isShortcutTextEntryTarget } from "../keyboardShortcutTargets";
import { autosizeMobileCommandTextarea } from "../mobileCommandTextarea";
import { usePiBridge } from "../pi/PiBridgeContext";
import { ScreenshotEditor } from "../pi/screenshot";
import type { ScreenshotSaveResult } from "../pi/screenshot";
import type { UploadCandidate, UploadedFile } from "../terminalUploads";
import { PiComposerSuggest, usePiComposerSuggest } from "./composer-suggest";
import { PiModelPicker } from "./PiModelPicker";
import { PiComposerHelpers, type PiComposerHelper } from "./PiComposerHelpers";
import { PiComposerHistory } from "./PiComposerHistory";
import type { PiComposerSuggestion } from "./composer-suggest";
import {
  PI_COMPOSER_MAX_ATTACHMENTS,
  piComposerAttachmentsFromFiles,
  piComposerEditedAttachment,
  piComposerImageFiles,
  piComposerScreenshotImage,
  piComposerUploadCandidates,
  releasePiComposerAttachment,
} from "./piComposerAttachments";
import type { PiComposerAttachment } from "./piComposerAttachments";
import { piComposerDeliveryParts } from "./piComposerDelivery";
import {
  clearPiComposerHistory,
  getPiComposerHistory,
  recordPiComposerHistory,
} from "./piComposerHistory";
import {
  clearPiComposerDraftIf,
  piComposerDraftKey,
  readPiComposerInputUnresolved,
  writePiComposerInputUnresolved,
  usePiComposerDraft,
} from "./piComposerDraft";
import { PI_COMPOSER_INSERT_EVENT, insertPiComposerText, type PiComposerInsertDetail } from "../pi/sidepanel/piComposerInsert";
import { usePiComposerViewport } from "./piComposerViewport";
import "./pi-mode.css";
import "./pi-composer-mobile.css";

/** Shared with every terminal input path; generation invalidates queued work on handoff. */
export type PiComposerInputOwner = {
  generation: number;
  mode: "idle" | "automatic" | "recovery" | "manual";
  canClaim?: () => boolean;
};

export type PiComposerProps = {
  inputOwner?: { current: PiComposerInputOwner };
  bridgeId: string;
  paneId: string;
  /** Phone layout: explicit launcher, Enter inserts a newline. */
  mobile: boolean;
  /** Whether this pane owns keyboard focus (selected or focused pane). */
  active: boolean;
  /** Terminal is not attached, so sending would be lost. */
  disabled: boolean;
  /** Lets TerminalView route its own focus requests into the Composer field. */
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  /** Parent focus request token; focuses the field while the Composer is open. */
  focusToken?: number;
  /**
   * Queues the prompt on the terminal socket. Returns false when nothing was
   * queued, which keeps the draft and attachments. `onDelivered` reports how
   * many of the queued frames reached the socket: fewer than `totalParts` means
   * a partially delivered prompt, so a cancelled send never clears anything.
   */
  onSend: (
    parts: string[],
    onDelivered: (deliveredParts: number, totalParts: number) => void,
  ) => boolean;
  /**
   * Uploads Attachment Chips through the same flow as TerminalView uploads.
   * Results must come back in the same order as the candidates. Absent means
   * attaching images is not available on this surface.
   */
  onUploadImages?: (files: UploadCandidate[]) => Promise<UploadedFile[]>;
  /** Optional pane-owned context rendered above the open editor. */
  conversationContext?: (editor: ReactNode) => ReactNode;
  /** Existing Key Bar / Reader surfaces, reached from the single mobile menu. */
  mobileTools?: ReactNode;
  onExpandedChange?: (expanded: boolean) => void;
  onTerminalFocus: () => void;
  onControlsHeightChange: (heightPx: number | null) => void;
};

/**
 * Native Pi Composer. Delivery is one bracketed paste plus a separate Enter,
 * so it works the same whether or not the Pi Bridge is reachable. Attached
 * images are uploaded first, then their paths are pasted ahead of the draft.
 */
export function PiComposer({
  inputOwner,
  bridgeId,
  paneId,
  mobile,
  active,
  disabled,
  inputRef,
  focusToken = 0,
  onSend,
  onUploadImages,
  conversationContext,
  mobileTools,
  onTerminalFocus,
  onExpandedChange,
  onControlsHeightChange,
}: PiComposerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const focusOnOpenRef = useRef(false);
  const composingRef = useRef(false);
  const mountedRef = useRef(true);
  // Guards survive re-renders and keep a sent value from being restored.
  const compositionGuardUntilRef = useRef(0);
  const acceptedValueRef = useRef("");
  const localInputOwner = useRef<PiComposerInputOwner>({ generation: 0, mode: "idle" });
  const owner = inputOwner ?? localInputOwner;
  const [manualInput, setManualInput] = useState(() => readPiComposerInputUnresolved(bridgeId, paneId));
  const setInputMode = useCallback((mode: PiComposerInputOwner["mode"]) => {
    writePiComposerInputUnresolved(bridgeId, paneId, mode !== "idle");
    owner.current.mode = mode;
  }, [bridgeId, paneId, owner]);
  const pendingSendRef = useRef(false);
  const claimInput = () => {
    setInputMode("automatic");
    return ++owner.current.generation;
  };
  const ownsInput = (generation: number) => mountedRef.current && owner.current.generation === generation;
  const handoffInput = useCallback(() => {
    if (owner.current.mode !== "automatic" && owner.current.mode !== "recovery") return;
    ++owner.current.generation;
    setInputMode("manual");
    pendingSendRef.current = false;
    setDeliveryPending(false);
    setSending(false);
    setActionError(null);
    setManualInput(true);
  }, [owner, setInputMode]);
  const [deliveryPending, setDeliveryPending] = useState(false);
  const [actionRecovery, setActionRecovery] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [value, setValue, setTransientValue] = usePiComposerDraft(bridgeId, paneId);
  acceptedValueRef.current = value;
  const piBridge = usePiBridge(paneId);
  const [cursor, setCursor] = useState(() => value.length);
  const [fieldFocused, setFieldFocused] = useState(false);
  const suggestionId = useId();
  const pendingCaretRef = useRef<number | null>(null);
  /** -1 means "editing the live draft"; otherwise index into pane history. */
  const historyRef = useRef({ index: -1, draft: "" });
  /** Any edit the user authored ends browsing, so recall cannot overwrite it. */
  const endHistoryBrowsing = useCallback(() => {
    historyRef.current = { index: -1, draft: "" };
  }, []);
  /**
   * Text the user authored or accepted: it ends history browsing and persists.
   * Recalling a prompt uses the transient setter instead.
   */
  const setAuthoredValue = useCallback(
    (next: string) => {
      endHistoryBrowsing();
      setValue(next);
    },
    [endHistoryBrowsing, setValue],
  );
  // Only one Composer popup may be open: completion, model picker or history.
  const [helpersOpen, setHelpersOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<string[]>([]);
  useEffect(() => {
    setHelpersOpen(false);
    setHistoryOpen(false);
    setModelOpen(false);
  }, [bridgeId, paneId, active, disabled, piBridge?.status]);
  /** Original text and image versions represented by the paste, reused by Enter-only recovery. */
  const recoveryDeliveryRef = useRef<{ text: string; attachments: PiComposerAttachment[] } | null>(null);
  const [open, setOpen] = useState(false);
  const viewport = usePiComposerViewport(mobile && open);
  /** The prompt text reached Pi but its Enter did not, so resending must not paste again. */
  const [awaitingSubmit, setAwaitingSubmit] = useState(false);
  const suggestion = usePiComposerSuggest({ api: piBridge, draft: value, cursor, enabled: open && active && fieldFocused && !disabled && !awaitingSubmit && !actionRecovery && !deliveryPending });
  const [attachments, setAttachments] = useState<PiComposerAttachment[]>([]);
  const attachmentsRef = useRef<PiComposerAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState<{
    attachment: PiComposerAttachment;
    image: { src: string; width: number; height: number };
  } | null>(null);

  useEffect(() => {
    if (!mobile || !open || !active) return;
    if (piBridge?.state?.busy !== "dialog" && !piBridge?.dialogs.length) return;
    setHelpersOpen(false);
    setHistoryOpen(false);
    setModelOpen(false);
    const card = rootRef.current?.closest(".terminal-stage")?.querySelector<HTMLButtonElement>("[data-pi-dialog-cards] button:not(:disabled)");
    card?.focus();
  }, [mobile, open, active, piBridge?.state?.busy, piBridge?.dialogs]);

  useEffect(() => {
    // React StrictMode mounts, unmounts and remounts in development. The
    // cleanup below clears the ref, so the effect body has to claim it back:
    // otherwise every async handler sees a "stale" component and silently
    // returns, and a send would stay stuck in `sending` forever.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const attachment of attachmentsRef.current) {
        releasePiComposerAttachment(attachment);
      }
      attachmentsRef.current = [];
    };
  }, []);

  // Input uncertainty outlives both keyed Composer and whole TerminalView mounts.
  useLayoutEffect(() => {
    owner.current.mode = readPiComposerInputUnresolved(bridgeId, paneId) ? "manual" : "idle";
    return () => {
      ++owner.current.generation;
      if (owner.current.mode !== "idle") setInputMode("manual");
    };
  }, [bridgeId, paneId, owner, setInputMode]);

  useLayoutEffect(() => {
    onExpandedChange?.(mobile && open && active);
    return () => onExpandedChange?.(false);
  }, [mobile, open, active, onExpandedChange]);


  // Native Cards are siblings, outside the terminal's inert subtree, but fit
  // the same visible viewport even when the native keyboard remains open.
  useLayoutEffect(() => {
    if (!mobile || !open) return;
    const stage = rootRef.current?.closest<HTMLElement>(".terminal-stage");
    if (!stage) return;
    for (const [name, value] of Object.entries(viewport)) {
      stage.style.setProperty(`--pi-viewport-${name}`, `${value}px`);
    }
  }, [mobile, open, viewport]);

  const setFieldNode = useCallback(
    (node: HTMLTextAreaElement | null) => {
      fieldRef.current = node;
      if (inputRef) {
        inputRef.current = node;
      }
    },
    [inputRef],
  );

  const replaceAttachments = useCallback((next: PiComposerAttachment[]) => {
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);

  const clearAttachments = useCallback((represented: PiComposerAttachment[]) => {
    replaceAttachments(attachmentsRef.current.filter((attachment) => {
      // Editing preserves chip IDs but replaces the object and preview URL.
      if (!represented.includes(attachment)) return true;
      releasePiComposerAttachment(attachment);
      return false;
    }));
  }, [replaceAttachments]);

  const addImageFiles = useCallback(
    (files: File[]) => {
      const images = piComposerAttachmentsFromFiles(files);
      if (images.length === 0) {
        return;
      }
      const current = attachmentsRef.current;
      const room = PI_COMPOSER_MAX_ATTACHMENTS - current.length;
      if (room <= 0) {
        for (const image of images) {
          releasePiComposerAttachment(image);
        }
        setAttachmentError(
          `You can attach up to ${PI_COMPOSER_MAX_ATTACHMENTS} images.`,
        );
        return;
      }
      const accepted = images.slice(0, room);
      for (const extra of images.slice(room)) {
        releasePiComposerAttachment(extra);
      }
      setAttachmentError(
        accepted.length < images.length
          ? `Only ${PI_COMPOSER_MAX_ATTACHMENTS} images can be attached; extra images were dropped.`
          : null,
      );
      replaceAttachments([...current, ...accepted]);
    },
    [replaceAttachments],
  );

  const removeAttachment = useCallback(
    (id: string) => {
      const target = attachmentsRef.current.find((attachment) => attachment.id === id);
      if (target) {
        releasePiComposerAttachment(target);
      }
      setAttachmentError(null);
      replaceAttachments(
        attachmentsRef.current.filter((attachment) => attachment.id !== id),
      );
    },
    [replaceAttachments],
  );

  const openScreenshotEditor = useCallback(async (attachment: PiComposerAttachment) => {
    try {
      const image = await piComposerScreenshotImage(attachment);
      if (!mountedRef.current) {
        return;
      }
      setAttachmentError(null);
      setEditing({ attachment, image });
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setAttachmentError(
        error instanceof Error ? error.message : "This image cannot be opened.",
      );
    }
  }, []);

  const closeScreenshotEditor = useCallback(() => setEditing(null), []);

  const saveEditedImage = useCallback(
    (result: ScreenshotSaveResult) => {
      const current = editing;
      setEditing(null);
      if (!current) {
        return;
      }
      const edited = piComposerEditedAttachment(current.attachment, result);
      if (!edited) {
        setAttachmentError("The edited image could not be saved; the original is kept.");
        return;
      }
      releasePiComposerAttachment(current.attachment);
      replaceAttachments(
        attachmentsRef.current.map((attachment) =>
          attachment.id === current.attachment.id ? edited : attachment,
        ),
      );
      setAttachmentError(null);
    },
    [editing, replaceAttachments],
  );

  const openComposer = useCallback(() => {
    focusOnOpenRef.current = true;
    flushSync(() => setOpen(true));
    // Ctrl+Space also returns focus to an already open Composer.
    fieldRef.current?.focus();
  }, []);

  useEffect(() => {
    const onInsert = (event: Event) => {
      const { key, text } = (event as CustomEvent<PiComposerInsertDetail>).detail;
      if (key !== piComposerDraftKey(bridgeId, paneId)) return;
      // A mounted Composer merges into its live draft, so text it is showing
      // without having persisted it (a recalled prompt) is not overwritten by
      // the stored draft.
      event.preventDefault();
      if (pendingSendRef.current || awaitingSubmit || actionRecovery) return;
      const next = `${value}${value && !/\s$/.test(value) ? "\n" : ""}${text}`;
      pendingCaretRef.current = next.length;
      setAuthoredValue(next);
      setCursor(next.length);
      openComposer();
    };
    window.addEventListener(PI_COMPOSER_INSERT_EVENT, onInsert);
    return () => window.removeEventListener(PI_COMPOSER_INSERT_EVENT, onInsert);
  }, [bridgeId, paneId, openComposer, setAuthoredValue, value, awaitingSubmit, actionRecovery]);

  const closeComposer = useCallback(() => {
    handoffInput();
    setHelpersOpen(false);
    setHistoryOpen(false);
    setModelOpen(false);
    setOpen(false);
    onTerminalFocus();
  }, [onTerminalFocus, handoffInput]);

  // Desktop defaults to terminal focus; Ctrl+Space is the only way in.
  useEffect(() => {
    if (!active) {
      return;
    }
    const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        event.key === " " &&
        event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        // Ctrl+Space is an app shortcut, so it never steals a key from a text
        // field, an open dialog, or an open menu.
        if (hasOpenModal() || hasOpenMenu() || isShortcutTextEntryTarget(event.target)) {
          return;
        }
        event.preventDefault();
        openComposer();
      }
    };
    document.addEventListener("keydown", onDocumentKeyDown, true);
    return () => document.removeEventListener("keydown", onDocumentKeyDown, true);
  }, [active, openComposer]);

  useLayoutEffect(() => {
    if (open && focusOnOpenRef.current) {
      focusOnOpenRef.current = false;
      fieldRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open || focusToken === 0) {
      return;
    }
    fieldRef.current?.focus();
  }, [focusToken, open]);

  useLayoutEffect(() => {
    if (open) {
      autosizeMobileCommandTextarea(fieldRef.current);
    }
  }, [open, value]);

  useLayoutEffect(() => {
    const caret = pendingCaretRef.current;
    if (caret === null) {
      return;
    }
    pendingCaretRef.current = null;
    const field = fieldRef.current;
    if (field && document.activeElement === field) {
      field.setSelectionRange(caret, caret);
    }
  }, [value]);

  const pickSuggestion = (item: PiComposerSuggestion) => {
    if (pendingSendRef.current || awaitingSubmit || actionRecovery) return;
    const next = suggestion.pick(item);
    if (!next) {
      return;
    }
    pendingCaretRef.current = next.cursor;
    setAuthoredValue(next.value);
    setCursor(next.cursor);
  };

  const insertSuggestionTrigger = (kind: PiComposerHelper) => {
    if (disabled || sending || pendingSendRef.current || awaitingSubmit || actionRecovery || composingRef.current) return;
    setHelpersOpen(false);
    setModelOpen(false);
    setHistoryOpen(false);
    const field = fieldRef.current;
    let start = field?.selectionStart ?? value.length;
    let end = field?.selectionEnd ?? start;
    const trigger = kind === "slash" ? "/" : kind === "shell" ? "!" : "@";
    // Commands and shell mode own the first character; file references use
    // the current selection and production spacing semantics.
    if (kind !== "file") {
      start = 0;
      end = /^[!/]/.test(value) ? 1 : 0;
    }
    field?.focus();
    const prefix = kind === "file" && start > 0 && !/\s/.test(value[start - 1]) ? " " : "";
    const nextValue = value.slice(0, start) + prefix + trigger + value.slice(end);
    const nextCursor = start + prefix.length + trigger.length;
    pendingCaretRef.current = nextCursor;
    field?.setSelectionRange(nextCursor, nextCursor);
    suggestion.reopen();
    setCursor(nextCursor);
    setAuthoredValue(nextValue);
  };

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      onControlsHeightChange(null);
      return;
    }
    const report = () => onControlsHeightChange(root.getBoundingClientRect().height);
    report();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", report);
      return () => {
        window.removeEventListener("resize", report);
        onControlsHeightChange(null);
      };
    }
    const observer = new ResizeObserver(report);
    observer.observe(root);
    return () => {
      observer.disconnect();
      onControlsHeightChange(null);
    };
  }, [
    onControlsHeightChange,
    open,
    attachments.length,
    attachmentError,
    sending,
    awaitingSubmit,
  ]);

  const clearAcceptedValue = useCallback(() => {
    // Reject delayed IME composition edits that would otherwise restore the sent
    // text into the field and the stored draft, mirroring the command composer.
    compositionGuardUntilRef.current = compositionGuardDeadline();
    acceptedValueRef.current = "";
    setAuthoredValue("");
  }, [setAuthoredValue]);

  /**
   * Queues a prompt and clears the Composer only once every frame reached the
   * socket. A partially delivered prompt keeps its text and records that Pi
   * already has it, so finishing it never pastes the same text twice.
   */
  const deliver = (
    parts: string[],
    sentValue: string,
    onDelivered: () => void,
    generation = claimInput(),
  ) => {
    pendingSendRef.current = true;
    setDeliveryPending(true);
    let settled = false;
    const accepted = onSend(parts, (deliveredParts, totalParts) => {
      if (!ownsInput(generation)) return;
      setInputMode(deliveredParts === totalParts || (deliveredParts === 0 && !awaitingSubmit) ? "idle" : "recovery");
      settled = true;
      pendingSendRef.current = false;
      setDeliveryPending(false);
      if (deliveredParts === totalParts) {
        setAwaitingSubmit(false);
        if (acceptedValueRef.current === sentValue) {
          clearAcceptedValue();
        } else {
          // The user recalled or retyped while this send was in flight; the live
          // text stays, but the delivered prompt must not return on reload.
          clearPiComposerDraftIf(bridgeId, paneId, sentValue);
        }
        onDelivered();
        return;
      }
      setAwaitingSubmit(deliveredParts > 0 || awaitingSubmit);
    });
    if (!accepted && !settled && ownsInput(generation)) {
      setInputMode(awaitingSubmit ? "recovery" : "idle");
      pendingSendRef.current = false;
      setDeliveryPending(false);
    }
    return accepted;
  };

  const send = async () => {
    // The draft clears only after the last frame reaches the socket, so a second
    // Send or Ctrl+Enter while that is pending would deliver the prompt twice.
    if (owner.current.canClaim?.() === false || manualInput || disabled || composingRef.current || sending || pendingSendRef.current || actionRecovery) {
      return;
    }
    const sentValue = value;
    const pending = attachmentsRef.current;
    if (awaitingSubmit || pending.length === 0) {
      // A partially delivered prompt already sits in Pi's editor, so finishing it
      // must send the Enter alone instead of pasting the text a second time.
      const parts = awaitingSubmit ? ["\r"] : piComposerDeliveryParts(value);
      // A blank draft would submit an empty prompt, so it is never delivered.
      if (parts.length === 0 || (!awaitingSubmit && value.trim().length === 0)) {
        return;
      }
      // Recovery sends only Enter, so it must record the text behind the partial
      // delivery instead of the empty draft left after the first attempt.
      const represented = awaitingSubmit ? recoveryDeliveryRef.current : { text: sentValue, attachments: [] };
      if (!represented) return;
      recoveryDeliveryRef.current = represented;
      deliver(parts, represented.text, () => {
        recordDeliveredPrompt(represented.text);
        clearAttachments(represented.attachments);
        recoveryDeliveryRef.current = null;
      });
      return;
    }
    if (!onUploadImages) {
      setAttachmentError("Image uploads are not available here.");
      return;
    }
    const generation = claimInput();
    const represented = { text: sentValue, attachments: pending };
    recoveryDeliveryRef.current = represented;
    pendingSendRef.current = true;
    setSending(true);
    setAttachmentError(null);
    try {
      const uploaded = await onUploadImages(piComposerUploadCandidates(pending));
      if (!ownsInput(generation)) {
        return;
      }
      if (uploaded.length !== pending.length) {
        throw new Error("Not every image could be uploaded; draft kept.");
      }
      const parts = piComposerDeliveryParts(
        value,
        uploaded.map((file) => file.path),
      );
      const accepted = deliver(parts, sentValue, () => {
        clearAttachments(represented.attachments);
        // Only the user's text is recalled, never the uploaded paths.
        recordDeliveredPrompt(represented.text);
        recoveryDeliveryRef.current = null;
      }, generation);
      if (!accepted && ownsInput(generation)) {
        setAttachmentError("Terminal is not attached; draft kept.");
      }
    } catch (error) {
      if (!ownsInput(generation)) return;
      setInputMode("idle");
      pendingSendRef.current = false;
      setAttachmentError(error instanceof Error ? error.message : "Upload failed");
    } finally {
      if (ownsInput(generation)) setSending(false);
    }
  };

  const recordDeliveredPrompt = (text: string | null) => {
    if (!text) return;
    recordPiComposerHistory(bridgeId, paneId, text);
    historyRef.current = { index: -1, draft: "" };
    // An open panel is a live view of the list, not a snapshot.
    if (historyOpen) setHistoryEntries(getPiComposerHistory(bridgeId, paneId));
  };

  useEffect(() => {
    // Typing a new prefix owns the popup; the model and history panels step aside.
    if (suggestion.isOpen && (modelOpen || historyOpen)) {
      setModelOpen(false);
      setHistoryOpen(false);
    }
  }, [historyOpen, modelOpen, suggestion.isOpen]);

  useEffect(() => {
    if (!open) {
      setModelOpen(false);
      setHistoryOpen(false);
    }
  }, [open]);

  const toggleHistory = () => {
    const next = !historyOpen;
    suggestion.close();
    setModelOpen(false);
    setHelpersOpen(false);
    setHistoryOpen(next);
    if (next) setHistoryEntries(getPiComposerHistory(bridgeId, paneId));
  };

  // Explicit Side Panel commands share the terminal queue, not draft delivery:
  // completing one must never clear or record the user's unsent prompt.
  const sendQuickAction: PiComposerProps["onSend"] = (parts, onDelivered) => {
    if (owner.current.canClaim?.() === false || manualInput || disabled || sending || pendingSendRef.current || awaitingSubmit || composingRef.current || (actionRecovery && (parts.length !== 1 || parts[0] !== "\r"))) return false;
    const generation = claimInput();
    pendingSendRef.current = true;
    setDeliveryPending(true);
    setActionError(null);
    const accepted = onSend(parts, (delivered, total) => {
      if (!ownsInput(generation)) return;
      setInputMode(delivered === total || (delivered === 0 && !actionRecovery) ? "idle" : "recovery");
      pendingSendRef.current = false;
      setDeliveryPending(false);
      setActionRecovery(delivered !== total && (delivered > 0 || actionRecovery));
      setActionError(delivered === total ? null : delivered > 0 || actionRecovery
        ? "Command text reached Pi without Enter. Submit the pending action without pasting again."
        : "Action was not delivered. The draft is unchanged.");
      onDelivered(delivered, total);
    });
    if (!accepted) {
      setInputMode(actionRecovery ? "recovery" : "idle");
      setActionError("Action could not be queued. The draft is unchanged.");
      pendingSendRef.current = false;
      setDeliveryPending(false);
    }
    return accepted;
  };

  const submit = () => {
    void send();
  };

  const onFieldKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      return;
    }
    if (suggestion.isOpen && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        suggestion.moveActive(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (
        suggestion.items.length > 0 &&
        (event.key === "Enter" || event.key === "Tab") &&
        !event.shiftKey
      ) {
        event.preventDefault();
        const picked = suggestion.pickActive();
        if (picked) {
          pendingCaretRef.current = picked.cursor;
          setAuthoredValue(picked.value);
          setCursor(picked.cursor);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        suggestion.close();
        return;
      }
    }
    if (event.key === "Escape" && !mobile) {
      event.preventDefault();
      closeComposer();
      return;
    }
    if (!mobile && event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.altKey) {
      event.preventDefault();
      submit();
    }
    if (
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
    ) {
      recall(event);
    }
  };

  /** Arrow keys recall this pane's prompts only from the draft's outer edges. */
  const recall = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const field = event.currentTarget;
    const start = field.selectionStart ?? 0;
    const end = field.selectionEnd ?? start;
    if (start !== end) return;
    const entries = getPiComposerHistory(bridgeId, paneId);
    const history = historyRef.current;
    const atTop = value.lastIndexOf("\n", start - 1) === -1 && start === 0;
    const atBottom = value.indexOf("\n", end) === -1 && end === value.length;
    const backward = event.key === "ArrowUp";
    // Only the first step needs a caret at the edge; browsing is free after that.
    if (history.index === -1 && (backward ? !atTop : !atBottom)) return;
    if (backward && history.index === -1 && entries.length === 0) return;
    if (!backward && history.index === -1) return;
    event.preventDefault();
    const next = backward
      ? Math.min(history.index + 1, entries.length - 1)
      : history.index - 1;
    if (next === -1) {
      historyRef.current = { index: -1, draft: "" };
      setTransientValue(history.draft);
      setCursor(history.draft.length);
      pendingCaretRef.current = history.draft.length;
      return;
    }
    historyRef.current = {
      index: next,
      draft: history.index === -1 ? value : history.draft,
    };
    // Recalling is transient: an old sent prompt must not be rewritten to disk.
    setTransientValue(entries[next]);
    setCursor(entries[next].length);
    pendingCaretRef.current = entries[next].length;
  };

  const onPasteImages = (event: ClipboardEvent<HTMLElement>) => {
    const files = piComposerImageFiles(event.clipboardData);
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    addImageFiles(files);
  };

  const onDropImages = (event: DragEvent<HTMLElement>) => {
    const files = piComposerImageFiles(event.dataTransfer);
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    addImageFiles(files);
  };

  const onDragOverImages = (event: DragEvent<HTMLElement>) => {
    if (piComposerImageFiles(event.dataTransfer).length > 0) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  };

  const onFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    addImageFiles(files);
  };

  const attachmentInput = onUploadImages ? <input ref={fileInputRef} className="pi-attachment-input" type="file" accept="image/*" multiple onChange={onFileInputChange} /> : null;
  const attachmentControl = onUploadImages ? (
      <button
        className="term-key pi-composer-attach"
        type="button"
        aria-label="Attach image"
        title="Attach image"
        disabled={sending}
        onClick={() => fileInputRef.current?.click()}
      >
        <ImagePlus size={16} aria-hidden="true" />
      </button>
        ) : null;

  const helpers = mobile ? (
    <PiComposerHelpers
      key={piComposerDraftKey(bridgeId, paneId)}
      api={piBridge}
      tools={mobileTools}
      onAttach={onUploadImages ? () => { setHelpersOpen(false); fileInputRef.current?.click(); } : undefined}
      onHistory={toggleHistory}
      onQuickAction={sendQuickAction}
      actionRecovery={actionRecovery && !manualInput}
      actionPending={deliveryPending || manualInput}
      actionError={actionError}
      authoringBlocked={manualInput || awaitingSubmit || actionRecovery || deliveryPending}
      onInsertCatalog={(text) => {
        if (disabled || sending || pendingSendRef.current || awaitingSubmit || actionRecovery || composingRef.current) return;
        setHelpersOpen(false);
        insertPiComposerText(bridgeId, paneId, text);
      }}
      open={helpersOpen}
      disabled={disabled || !active || sending || (deliveryPending && !helpersOpen)}
      online={piBridge?.status === "online"}
      filesAvailable={piBridge?.capabilities.list_files === true}
      onOpen={() => {
        suggestion.close();
        setModelOpen(false);
        setHistoryOpen(false);
        setHelpersOpen(true);
      }}
      onClose={() => setHelpersOpen(false)}
      onPick={insertSuggestionTrigger}
    />
  ) : null;


  if (!open || (mobile && !active)) {
    return (
      <div
        ref={rootRef}
        className="terminal-command-controls pi-composer"
        data-mobile-controls={mobile ? "true" : "false"}
      >
        <button
          className="term-send pi-composer-open"
          type="button"
          aria-label="Open Composer"
          disabled={!active}
          title="Open Composer (Ctrl+Space)"
          onClick={openComposer}
        >
          {mobile ? <span aria-hidden="true">+</span> : <><TextCursorInput size={16} aria-hidden="true" /><span>Open Composer</span></>}
        </button>
      </div>
    );
  }

  const showAttachments = attachments.length > 0 || attachmentError !== null;

  return (
    <>
      {editing ? (
        <ScreenshotEditor
          image={editing.image}
          onSave={saveEditedImage}
          onCancel={closeScreenshotEditor}
        />
      ) : null}
      <div
        ref={rootRef}
        className="terminal-command-controls pi-composer"
        data-mobile-controls={mobile ? "true" : "false"}
        data-expanded={open ? "true" : "false"}
        data-compact={viewport.height <= 600 ? "true" : "false"}
        data-short={viewport.height <= 450 ? "true" : "false"}
        style={mobile ? {
          "--pi-viewport-left": `${viewport.left}px`,
          "--pi-viewport-top": `${viewport.top}px`,
          "--pi-viewport-width": `${viewport.width}px`,
          "--pi-viewport-height": `${viewport.height}px`,
        } as CSSProperties : undefined}
        onPaste={onPasteImages}
        onDrop={onDropImages}
        onDragOver={onDragOverImages}
      >
      {manualInput ? <div role="status" className="pi-composer-manual-input">
        <p>Finish or clear the pending input in the terminal. Draft and images are kept; Enter/Esc do not confirm completion.</p>
        <button type="button" aria-label="Terminal input is empty; keep draft" onClick={() => {
          ++owner.current.generation;
          setInputMode("idle");
          setManualInput(false);
          setAwaitingSubmit(false);
          setActionRecovery(false);
          setActionError(null);
          recoveryDeliveryRef.current = null;
        }}>Terminal input is empty; keep draft</button>
      </div> : null}
      {showAttachments ? (
        <div className="pi-composer-attachments">
          {attachments.length > 0 ? (
            <ul className="pi-attachment-list">
              {attachments.map((attachment, index) => {
                const label = attachment.name || `image ${index + 1}`;
                return (
                  <li
                    key={attachment.id}
                    className="pi-attachment-chip"
                    data-pi-attachment="chip"
                  >
                    <button
                      className="pi-attachment-preview"
                      type="button"
                      aria-label={`Edit ${label}`}
                      title={`Edit ${label}`}
                      onClick={() => void openScreenshotEditor(attachment)}
                    >
                      <img
                        className="pi-attachment-thumb"
                        src={attachment.thumbnailUrl || undefined}
                        alt=""
                      />
                    </button>
                    <span className="pi-attachment-name">{label}</span>
                    <button
                      className="pi-attachment-remove"
                      type="button"
                      aria-label="Remove attachment"
                      title={`Remove ${label}`}
                      disabled={sending}
                      onClick={() => removeAttachment(attachment.id)}
                    >
                      <X size={14} />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {attachmentError ? (
            <div className="pi-attachment-error" role="alert">
              {attachmentError}
            </div>
          ) : null}
        </div>
      ) : null}
      {historyOpen ? (
        <PiComposerHistory
          entries={historyEntries}
          onPick={(text) => {
            setHistoryOpen(false);
            // Picking is recall too, so it does not write the old prompt to disk.
            setTransientValue(text);
            setCursor(text.length);
            pendingCaretRef.current = text.length;
            historyRef.current = { index: -1, draft: "" };
            fieldRef.current?.focus();
          }}
          onClear={() => {
            clearPiComposerHistory(bridgeId, paneId);
            historyRef.current = { index: -1, draft: "" };
            setHistoryEntries([]);
          }}
          onClose={() => {
            setHistoryOpen(false);
            fieldRef.current?.focus();
          }}
        />
      ) : null}
      {suggestion.isOpen && !awaitingSubmit && !actionRecovery && !deliveryPending && !modelOpen && !historyOpen && !helpersOpen ? (
        <PiComposerSuggest
          id={suggestionId}
          items={suggestion.items}
          activeIndex={suggestion.activeIndex}
          loading={suggestion.loadingFiles}
          error={suggestion.error}
          onActiveChange={suggestion.setActiveIndex}
          onPick={pickSuggestion}
        />
      ) : null}
      {awaitingSubmit && !manualInput ? (
        <p className="pi-composer-recovery" role="status">
          Prompt text reached Pi without Enter. Send submits it without pasting again.
        </p>
      ) : null}
      {attachmentInput}
      <div className="pi-composer-meta">
        <PiModelPicker
          api={piBridge}
          disabled={disabled}
          compact
          open={modelOpen}
          onOpenChange={(next) => {
            if (next) {
              suggestion.close();
              setHistoryOpen(false);
              setHelpersOpen(false);
            }
            setModelOpen(next);
          }}
        />
        {!mobile ? <button
          className="term-key pi-composer-history-trigger"
          type="button"
          aria-label="Open prompt history"
          title="Recent prompts"
          aria-expanded={historyOpen}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={toggleHistory}
        >
          <History size={16} aria-hidden="true" />
          <span className="pi-composer-action-label">History</span>
        </button> : null}
        {!mobile ? <>
        <button
          className="term-key pi-composer-suggest-trigger"
          type="button"
          aria-label="Open slash suggestions"
          title="Commands and skills (/)"
          disabled={disabled || sending}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => insertSuggestionTrigger("slash")}
        >
          <span aria-hidden="true">/</span>
          <span className="pi-composer-action-label">Slash</span>
        </button>
        <button
          className="term-key pi-composer-suggest-trigger"
          type="button"
          aria-label="Open file suggestions"
          title="Files (@)"
          disabled={disabled || sending}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => insertSuggestionTrigger("file")}
        >
          <span aria-hidden="true">@</span>
          <span className="pi-composer-action-label">File</span>
        </button>
        </> : null}
      </div>
      {piBridge?.state?.busy === "dialog" ? <p className="pi-composer-dialog-status" role="status">Pi needs an answer. Use the Native Card or Return to terminal for terminal-only dialogs.</p> : null}
      {(mobile && conversationContext ? conversationContext : (editor: ReactNode) => editor)(<form
        className="term-input-row pi-composer-row"
        data-expanding="true"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {mobile ? <label className="pi-composer-followup" htmlFor={suggestionId + "-prompt"}>Follow up</label> : null}
        <textarea
          id={suggestionId + "-prompt"}
          ref={setFieldNode}
          className="term-native-input mono pi-composer-input"
          rows={1}
          data-expanding="true"
          aria-label="Pi prompt"
          placeholder="Write a prompt for Pi"
          autoCapitalize="sentences"
          autoComplete="off"
          autoCorrect="on"
          enterKeyHint={mobile ? "enter" : "send"}
          spellCheck
          disabled={disabled}
          value={value}
          aria-expanded={suggestion.isOpen}
          aria-controls={suggestion.isOpen ? suggestionId : undefined}
          onFocus={() => setFieldFocused(true)}
          onBlur={() => setFieldFocused(false)}
          aria-activedescendant={suggestion.isOpen && suggestion.items.length ? `${suggestionId}-${suggestion.activeIndex}` : undefined}
          onChange={(event) => {
            if (isLateCompositionEdit(event.nativeEvent, compositionGuardUntilRef.current)) {
              // Native composition edits may not be cancelable, so restore the
              // accepted value instead of re-saving text that was just sent.
              event.currentTarget.value = acceptedValueRef.current;
              return;
            }
            acceptedValueRef.current = event.target.value;
            if (historyRef.current.index !== -1) {
              // Editing a recalled prompt ends browsing: the edited text becomes the
              // live draft, so ArrowUp/Down cannot overwrite the user's edits.
              historyRef.current = { index: -1, draft: "" };
            }
            setValue(event.target.value);
            setCursor(event.target.selectionStart ?? event.target.value.length);
          }}
          onSelect={(event) =>
            setCursor(event.currentTarget.selectionStart ?? event.currentTarget.value.length)
          }
          onClick={(event) =>
            setCursor(event.currentTarget.selectionStart ?? event.currentTarget.value.length)
          }
          onKeyUp={(event) =>
            setCursor(event.currentTarget.selectionStart ?? event.currentTarget.value.length)
          }
          onCompositionStart={() => {
            composingRef.current = true;
            // A new composition belongs to the next prompt, so it must not be
            // treated as a late edit of the one that was just sent.
            compositionGuardUntilRef.current = 0;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onKeyDown={onFieldKeyDown}
        />
        {!mobile ? attachmentControl : null}
        <div className={mobile ? "pi-composer-thumbrail" : "pi-composer-desktop-actions"}>
        {helpers}
        <button
          className="term-send pi-composer-send"
          type="submit"
          disabled={manualInput || disabled || sending || deliveryPending || actionRecovery || (value.length === 0 && attachments.length === 0)}
          aria-label={awaitingSubmit && !manualInput ? "Submit prompt" : "Send prompt"}
          title={awaitingSubmit && !manualInput ? "Submit the pasted prompt" : "Send (Ctrl+Enter)"}
        >
          <Send size={16} />
          <span className="pi-composer-send-label">{awaitingSubmit && !manualInput ? "Submit" : "Send"}</span>
        </button>
        {mobile ? <button className="term-key pi-composer-stop" type="button" aria-label="Stop Pi"
          disabled={disabled || !active || sending || deliveryPending || awaitingSubmit || actionRecovery || piBridge?.state?.busy === "idle"}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onSend(["\u001b"], () => {})}>
          <Square size={16} aria-hidden="true" /><span>Stop</span>
        </button> : null}
        {mobile ? (
          <button className="term-key pi-composer-terminal" type="button" aria-label="Return to terminal" onClick={closeComposer}>
            <Terminal size={16} aria-hidden="true" /><span>Terminal</span>
          </button>
        ) : (
          <button
            className="term-key pi-composer-close"
            type="button"
            aria-label="Close Composer (Esc)"
            title="Close Composer (Esc)"
            onClick={closeComposer}
          >
            Esc
          </button>
        )}
        </div>
      </form>)}
      </div>
    </>
  );
}

/** Re-exported for TerminalView wiring without importing the helper module directly. */
export type { PiComposerAttachment };
