import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { safeMarkdownUrl } from "./markdown";

export type NoteMarkdownPreviewProps = {
  body: string;
};

export default function NoteMarkdownPreview({ body }: NoteMarkdownPreviewProps) {
  if (!body.trim()) {
    return <span className="note-body-preview-empty">No content</span>;
  }
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
      }}
    >
      {body}
    </ReactMarkdown>
  );
}
