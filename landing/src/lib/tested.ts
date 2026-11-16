/**
 * What the current Helicon build was tested against. The SEO pages, the home page and /facts.json
 * all read these, so a figure on the site never drifts from the one in the facts.
 *
 * Bump MUSE_CODE_TESTED with the @muse-code/sdk range in packages/daemon/package.json;
 * test/tested.test.ts fails when the two disagree.
 */
export const MUSE_CODE_TESTED = { version: "1.4.20", date: "2026-11-14" } as const;

/** Desktop builds, in the order the install section lists them. */
export const DESKTOP_OS = ["Windows", "macOS", "Linux"] as const;

/** Meta's Muse Code docs, the source for anything the site says about the CLI itself. */
export const MUSE_CODE_DOCS_URL = "https://dev.meta.ai/products/muse-code/";

/** "Windows, macOS and Linux". */
export const DESKTOP_OS_TEXT = `${DESKTOP_OS.slice(0, -1).join(", ")} and ${DESKTOP_OS.at(-1)}`;
