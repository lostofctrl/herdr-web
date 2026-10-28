import { ImagePlus, Send, TextCursorInput, X } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, KeyboardEvent, ClipboardEvent, RefObject } from "react";

import { compositionGuardDeadline, isLateCompositionEdit } from "../commandTextFieldGuard";
import { hasOpenMenu, hasOpenModal, isShortcutTextEntryTarget } from "../keyboardShortcutTargets";
import { autosizeMobileCommandTextarea } from "../mobileCommandTextarea";
import { usePiBridge } from "../pi/PiBridgeContext";
import { ScreenshotEditor } from "../pi/screenshot";
import type { ScreenshotSaveResult } from "../pi/screenshot";
import type { UploadCandidate, UploadedFile } from "../terminalUploads";
import { PiComposerSuggest, usePiComposerSuggest } from "./composer-suggest";
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
import { piComposerDraftKey, usePiComposerDraft } from "./piComposerDraft";
import { PI_COMPOSER_INSERT_EVENT, type PiComposerInsertDetail } from "../pi/sidepanel/piComposerInsert";
import "./pi-mode.css";

export type PiComposerProps = {
  bridgeId: string;
  paneId: string;
  /** Phone layout: always open, Enter inserts a newline, tap the big Send button. */
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
  onTerminalFocus: () => void;
  onControlsHeightChange: (heightPx: number | null) => void;
};

/**
 * Native Pi Composer. Delivery is one bracketed paste plus a separate Enter,
 * so it works the same whether or not the Pi Bridge is reachable. Attached
 * images are uploaded first, then their paths are pasted ahead of the draft.
 */
export function PiComposer({
  bridgeId,
  paneId,
  mobile,
  active,
  disabled,
  inputRef,
  focusToken = 0,
  onSend,
  onUploadImages,
  onTerminalFocus,
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
  const pendingSendRef = useRef(false);
  const [value, setValue] = usePiComposerDraft(bridgeId, paneId);
  acceptedValueRef.current = value;
  const piBridge = usePiBridge(paneId);
  const [cursor, setCursor] = useState(() => value.length);
  const suggestion = usePiComposerSuggest({ api: piBridge, draft: value, cursor });
  const suggestionId = useId();
  const pendingCaretRef = useRef<number | null>(null);
  const [open, setOpen] = useState(mobile);
  const [attachments, setAttachments] = useState<PiComposerAttachment[]>([]);
  const attachmentsRef = useRef<PiComposerAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  /** The prompt text reached Pi but its Enter did not, so resending must not paste again. */
  const [awaitingSubmit, setAwaitingSubmit] = useState(false);
  const [editing, setEditing] = useState<{
    attachment: PiComposerAttachment;
    image: { src: string; width: number; height: number };
  } | null>(null);

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

  useEffect(() => {
    if (mobile) {
      setOpen(true);
    }
  }, [mobile]);

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

  const clearAttachments = useCallback(() => {
    for (const attachment of attachmentsRef.current) {
      releasePiComposerAttachment(attachment);
    }
    replaceAttachments([]);
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
    setOpen(true);
    // Ctrl+Space also returns focus to an already open Composer.
    fieldRef.current?.focus();
  }, []);

  useEffect(() => {
    const onInsert = (event: Event) => {
      const { key, value: next } = (event as CustomEvent<PiComposerInsertDetail>).detail;
      if (key !== piComposerDraftKey(bridgeId, paneId)) return;
      setValue(next);
      openComposer();
    };
    window.addEventListener(PI_COMPOSER_INSERT_EVENT, onInsert);
    return () => window.removeEventListener(PI_COMPOSER_INSERT_EVENT, onInsert);
  }, [bridgeId, paneId, openComposer, setValue]);

  const closeComposer = useCallback(() => {
    setOpen(false);
    onTerminalFocus();
  }, [onTerminalFocus]);

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
    const next = suggestion.pick(item);
    if (!next) {
      return;
    }
    pendingCaretRef.current = next.cursor;
    setValue(next.value);
    setCursor(next.cursor);
  };

  const insertSuggestionTrigger = (kind: "slash" | "file") => {
    const field = fieldRef.current;
    let start = field?.selectionStart ?? value.length;
    let end = field?.selectionEnd ?? start;
    const trigger = kind === "slash" ? "/" : "@";
    // A slash command must be the draft's first character, so the button
    // prepends it instead of leaving an unusable token mid-prompt.
    if (kind === "slash" && !value.startsWith("/")) {
      start = 0;
      end = 0;
    }
    const nextValue = value.slice(0, start) + trigger + value.slice(end);
    const nextCursor = start + trigger.length;
    pendingCaretRef.current = nextCursor;
    setCursor(nextCursor);
    setValue(nextValue);
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
    setValue("");
  }, [setValue]);

  /**
   * Queues a prompt and clears the Composer only once every frame reached the
   * socket. A partially delivered prompt keeps its text and records that Pi
   * already has it, so finishing it never pastes the same text twice.
   */
  const deliver = (
    parts: string[],
    sentValue: string,
    onDelivered: () => void,
  ) => {
    pendingSendRef.current = true;
    let settled = false;
    const accepted = onSend(parts, (deliveredParts, totalParts) => {
      settled = true;
      pendingSendRef.current = false;
      if (deliveredParts === totalParts) {
        setAwaitingSubmit(false);
        if (acceptedValueRef.current === sentValue) {
          clearAcceptedValue();
        }
        onDelivered();
        return;
      }
      setAwaitingSubmit(deliveredParts > 0);
    });
    if (!accepted && !settled) {
      pendingSendRef.current = false;
    }
    return accepted;
  };

  const send = async () => {
    // The draft clears only after the last frame reaches the socket, so a second
    // Send or Ctrl+Enter while that is pending would deliver the prompt twice.
    if (disabled || composingRef.current || sending || pendingSendRef.current) {
      return;
    }
    const sentValue = value;
    const pending = attachmentsRef.current;
    if (pending.length === 0) {
      // A partially delivered prompt already sits in Pi's editor, so finishing it
      // must send the Enter alone instead of pasting the text a second time.
      const parts = awaitingSubmit ? ["\r"] : piComposerDeliveryParts(value);
      // A blank draft would submit an empty prompt, so it is never delivered.
      if (parts.length === 0 || (!awaitingSubmit && value.trim().length === 0)) {
        return;
      }
      deliver(parts, sentValue, () => {});
      return;
    }
    if (!onUploadImages) {
      setAttachmentError("Image uploads are not available here.");
      return;
    }
    setSending(true);
    setAttachmentError(null);
    try {
      const uploaded = await onUploadImages(piComposerUploadCandidates(pending));
      if (!mountedRef.current) {
        return;
      }
      if (uploaded.length !== pending.length) {
        throw new Error("Not every image could be uploaded; draft kept.");
      }
      const parts = piComposerDeliveryParts(
        value,
        uploaded.map((file) => file.path),
      );
      const accepted = deliver(parts, sentValue, () => clearAttachments());
      if (!accepted) {
        setAttachmentError("Terminal is not attached; draft kept.");
      }
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setAttachmentError(error instanceof Error ? error.message : "Upload failed");
    } finally {
      if (mountedRef.current) {
        setSending(false);
      }
    }
  };

  const submit = () => {
    void send();
  };

  const onFieldKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      return;
    }
    if (suggestion.isOpen) {
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
          setValue(picked.value);
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

  if (!open) {
    return (
      <div
        ref={rootRef}
        className="terminal-command-controls pi-composer"
        data-mobile-controls="false"
      >
        <button
          className="term-send pi-composer-open"
          type="button"
          aria-label="Open Composer"
          title="Open Composer (Ctrl+Space)"
          onClick={openComposer}
        >
          <TextCursorInput size={16} />
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
        onPaste={onPasteImages}
        onDrop={onDropImages}
        onDragOver={onDragOverImages}
      >
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
      {suggestion.isOpen ? (
        <PiComposerSuggest
          id={suggestionId}
          items={suggestion.items}
          activeIndex={suggestion.activeIndex}
          loading={suggestion.loadingFiles}
          onActiveChange={suggestion.setActiveIndex}
          onPick={pickSuggestion}
        />
      ) : null}
      {awaitingSubmit ? (
        <p className="pi-composer-recovery" role="status">
          Prompt text reached Pi without Enter. Send submits it without pasting again.
        </p>
      ) : null}
      <form
        className="term-input-row pi-composer-row"
        data-expanding="true"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
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
          onChange={(event) => {
            if (isLateCompositionEdit(event.nativeEvent, compositionGuardUntilRef.current)) {
              // Native composition edits may not be cancelable, so restore the
              // accepted value instead of re-saving text that was just sent.
              event.currentTarget.value = acceptedValueRef.current;
              return;
            }
            acceptedValueRef.current = event.target.value;
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
        <button
          className="term-key pi-composer-suggest-trigger"
          type="button"
          aria-label="Open slash suggestions"
          title="Commands and skills (/)"
          disabled={disabled || sending}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => insertSuggestionTrigger("slash")}
        >
          /
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
          @
        </button>
        {onUploadImages ? (
          <>
            <input
              ref={fileInputRef}
              className="pi-attachment-input"
              type="file"
              accept="image/*"
              multiple
              onChange={onFileInputChange}
            />
            <button
              className="term-key pi-composer-attach"
              type="button"
              aria-label="Attach image"
              title="Attach image"
              disabled={sending}
              onClick={() => fileInputRef.current?.click()}
            >
              <ImagePlus size={16} />
            </button>
          </>
        ) : null}
        <button
          className="term-send pi-composer-send"
          type="submit"
          disabled={disabled || sending || (value.length === 0 && attachments.length === 0)}
          aria-label={awaitingSubmit ? "Submit prompt" : "Send prompt"}
          title={awaitingSubmit ? "Submit the pasted prompt" : "Send (Ctrl+Enter)"}
        >
          <Send size={16} />
          <span className="pi-composer-send-label">Send</span>
        </button>
        {!mobile ? (
          <button
            className="term-key pi-composer-close"
            type="button"
            aria-label="Close Composer"
            title="Close Composer (Esc)"
            onClick={closeComposer}
          >
            Esc
          </button>
        ) : null}
      </form>
      </div>
    </>
  );
}

/** Re-exported for TerminalView wiring without importing the helper module directly. */
export type { PiComposerAttachment };
