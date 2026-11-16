import { invoke } from "@tauri-apps/api/core";
import { catchOutsideLinks } from "@helicon/ui";

export { externalHref } from "@helicon/ui";

/**
 * In the desktop app, a plain click on a `target="_blank"` link never reaches the shell's new-window handler on
 * macOS, so nothing opens. Clicks on outside links go straight to the default browser instead.
 */
export function bindDesktopLinks(): void {
  if (!("__TAURI_INTERNALS__" in window)) {
    return;
  }
  catchOutsideLinks((url) => void invoke("plugin:opener|open_url", { url }).catch(() => undefined));
}
