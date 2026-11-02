import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Maximum number of UTF-16 code units parsed and rendered in one preview. */
export const MARKDOWN_PREVIEW_MAX_LENGTH = 32_768;

export interface InertMarkdownProps {
  content: string;
}

/** A bounded Markdown-only preview. Links, images and raw HTML are never active. */
export function InertMarkdown({ content }: InertMarkdownProps) {
  if (content.length > MARKDOWN_PREVIEW_MAX_LENGTH) {
    return <p role="alert">Markdown preview is too large to display.</p>;
  }

  return (
    <ReactMarkdown
      skipHtml
      remarkPlugins={[remarkGfm]}
      urlTransform={() => ""}
      allowedElements={[
        "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6",
        "hr", "img", "input", "li", "ol", "p", "pre", "section", "strong", "sup", "table",
        "tbody", "td", "th", "thead", "tr", "ul",
      ]}
      components={{
        a: ({ children }) => <span>{children}</span>,
        img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : "[Image]"}</span>,
        input: ({ checked }) => <input type="checkbox" checked={checked} disabled readOnly />,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
