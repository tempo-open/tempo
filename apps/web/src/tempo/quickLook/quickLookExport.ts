import documentCss from "./quickLookDocument.css?raw";

const PAGE_CSS = `
html { background: #fff; }
body { margin: 0; padding: 72px 24px 120px; background: #fff; }
@media (min-width: 900px) { body { padding: 96px 96px 160px; } }
`;

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ??
      character,
  );

/**
 * A standalone page of the document as the card shows it, for the browser.
 * Controls drop out, and images and links keep absolute addresses so they still
 * resolve from a file on disk.
 */
export function documentPageHtml(
  article: HTMLElement,
  title: string,
  /** The absolute file a relative link points at, or null to leave it as text. */
  resolveFileHref: (href: string) => string | null,
): string {
  const copy = article.cloneNode(true) as HTMLElement;
  for (const element of copy.querySelectorAll("[data-doc-ui]")) element.remove();
  for (const element of copy.querySelectorAll("[data-revealed]")) {
    element.removeAttribute("data-revealed");
  }
  const images = article.querySelectorAll("img");
  copy.querySelectorAll("img").forEach((image, index) => {
    const live = images[index];
    if (live?.currentSrc || live?.src) image.setAttribute("src", live.currentSrc || live.src);
    image.removeAttribute("loading");
  });
  for (const link of copy.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href") ?? "";
    if (/^(?:https?|mailto):/i.test(href) || href.startsWith("#")) continue;
    const file = resolveFileHref(href);
    if (file) link.setAttribute("href", `file://${encodeURI(file)}`);
    else link.removeAttribute("href");
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${escapeHtml(title)}</title>
<style>${PAGE_CSS}${documentCss}</style>
</head>
<body>
${copy.outerHTML}
</body>
</html>
`;
}
