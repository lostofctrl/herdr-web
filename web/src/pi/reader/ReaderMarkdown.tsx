import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { copyToClipboard } from "../../clipboard";
import { safeMarkdownUrl } from "../../markdown";

type HastNode = { type?: string; value?: string; children?: HastNode[] };

function hastText(node: unknown): string {
  if (!node || typeof node !== "object") {
    return "";
  }
  const current = node as HastNode;
  if (current.type === "text") {
    return current.value ?? "";
  }
  if (Array.isArray(current.children)) {
    return current.children.map(hastText).join("");
  }
  return "";
}

/** Fenced code blocks get their own copy control; inline code stays inline. */
function CodeBlock({ node, children, ...props }: ComponentPropsWithoutRef<"pre"> & {
  node?: unknown;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) {
        window.clearTimeout(resetTimer.current);
      }
    },
    [],
  );

  const code = hastText(node).replace(/\n$/, "");

  const onCopy = async () => {
    try {
      await copyToClipboard(code);
      setState("copied");
    } catch {
      setState("failed");
    }
    if (resetTimer.current !== null) {
      window.clearTimeout(resetTimer.current);
    }
    resetTimer.current = window.setTimeout(() => setState("idle"), 1800);
  };

  return (
    <div className="reader-code">
      <button
        className="reader-code-copy"
        type="button"
        aria-label="Copy code block"
        onClick={() => void onCopy()}
      >
        {state === "copied" ? <Check size={14} /> : <Copy size={14} />}
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
      </button>
      <pre {...props}>{children}</pre>
    </div>
  );
}

/** Formatted Markdown for the Reader Sheet, sharing the app's safe URL rules. */
export function ReaderMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      disallowedElements={["img"]}
      remarkPlugins={[remarkGfm]}
      urlTransform={safeMarkdownUrl}
      components={{
        a: ({ node, children, href, ...props }) => {
          void node;
          return href ? (
            <a {...props} href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ) : (
            <span>{children}</span>
          );
        },
        pre: CodeBlock,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
