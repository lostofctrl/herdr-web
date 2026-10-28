import type { UrlTransform } from "react-markdown";

/** Only absolute http(s) links survive; anything else is dropped. */
export const safeMarkdownUrl: UrlTransform = (url, key) => {
  if (key !== "href") {
    return null;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
};
