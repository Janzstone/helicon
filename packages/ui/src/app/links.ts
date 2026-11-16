/** A web or mail link that belongs outside Helicon: not the local server this page came from. */
export function externalHref(href: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.protocol === "mailto:") {
    return url.href;
  }
  if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== origin) {
    return url.href;
  }
  return null;
}

/**
 * Calls `open` with the target of each plain left click on an outside link, instead of letting the page follow it.
 * Returns the function that stops listening.
 */
export function catchOutsideLinks(open: (url: string) => void): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.button !== 0 || event.defaultPrevented) {
      return;
    }
    const anchor = (event.target as Element | null)?.closest?.("a[href]");
    const href = anchor?.getAttribute("href");
    const target = href ? externalHref(href, window.location.origin) : null;
    if (!target) {
      return;
    }
    event.preventDefault();
    open(target);
  };
  document.addEventListener("click", onClick, true);
  return () => document.removeEventListener("click", onClick, true);
}
