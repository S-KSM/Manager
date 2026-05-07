/**
 * Pure parser for the `dispatch://` URL scheme used by the macOS app's
 * `CFBundleURLTypes` registration and the `/dispatcher` Claude Code slash
 * command (`commands/dispatcher.md`).
 *
 * Only one shape is recognized today:
 *   dispatch://workstream/<slug>[?…ignored…][/]
 *
 * The slug must be a non-empty string of `[a-z0-9-]` (matches the slugifier
 * in `hooks/_common.sh:dispatch__slugify`). Caps, slashes inside the slug,
 * and `..` are rejected — caller-supplied slugs flow into UI selection state
 * and (eventually) filesystem paths, so we keep the parser strict.
 */
export type DispatchURL = { kind: 'workstream'; id: string };

const SLUG_RE = /^[a-z0-9-]+$/;

export function parseDispatchURL(input: string): DispatchURL | null {
  if (typeof input !== 'string' || input.length === 0) return null;

  // Reject `..` / `.` segments by inspecting the raw input — WHATWG URL
  // normalizes them out of the path, so by the time we see `url.pathname`
  // a malicious `dispatch://workstream/../etc` looks identical to a
  // legitimate `dispatch://workstream/etc`.
  const rawAfterHost = input.replace(/^dispatch:\/\/workstream/i, '');
  if (rawAfterHost !== input) {
    if (/(^|\/)\.\.(\/|$)/.test(rawAfterHost) || /(^|\/)\.(\/|$)/.test(rawAfterHost)) {
      return null;
    }
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'dispatch:') return null;
  if (url.host !== 'workstream') return null;

  // Strip the leading slash and any single trailing slash, then reject
  // anything that still contains a `/` (path traversal, nested paths).
  const path = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  if (path.length === 0) return null;
  if (path.includes('/')) return null;
  if (path === '..' || path === '.') return null;
  if (!SLUG_RE.test(path)) return null;

  return { kind: 'workstream', id: path };
}
