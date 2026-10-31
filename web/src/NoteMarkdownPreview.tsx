import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { BridgeHttpUrl } from "./bridgeApi";
import { safeMarkdownUrl } from "./markdown";
import { noteImagePath } from "./noteImages";

export type NoteMarkdownPreviewProps = {
  body: string;
  httpUrl?: BridgeHttpUrl;
};

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };

// Bound concurrent image requests and blob memory even for a crafted note body.
function limitNoteImages() {
  return (tree: MarkdownNode) => {
    let count = 0;
    const walk = (node: MarkdownNode) => {
      if (node.type === "image" || node.type === "imageReference") {
        count += 1;
        if (count > 20) {
          node.type = "text";
          node.value = "[Image preview limit reached]";
        }
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

function NoteImage({ path, alt, httpUrl }: { path: string; alt: string; httpUrl: BridgeHttpUrl }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setSrc(null);
    void fetch(httpUrl(path), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Image unavailable");
        return response.blob();
      })
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => {});
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [httpUrl, path]);
  return src ? <img src={src} alt={alt} /> : <span>{alt || "Image unavailable"}</span>;
}

export default function NoteMarkdownPreview({ body, httpUrl }: NoteMarkdownPreviewProps) {
  const Image = useMemo(() => function Image({ src, alt }: { src?: string; alt?: string }) {
    return src && httpUrl ? <NoteImage path={src} alt={alt ?? ""} httpUrl={httpUrl} /> : null;
  }, [httpUrl]);
  if (!body.trim()) {
    return <span className="note-body-preview-empty">No content</span>;
  }
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, limitNoteImages]}
      urlTransform={(url, key, node) => key === "src" ? noteImagePath(url) : safeMarkdownUrl(url, key, node)}
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
        img: Image,
      }}
    >
      {body}
    </ReactMarkdown>
  );
}
