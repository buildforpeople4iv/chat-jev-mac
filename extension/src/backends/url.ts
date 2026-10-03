/**
 * Jev endpoint composition — the same three-case rule as src/generate.py's
 * jev_request_url (issue #42). A base that tests fine in the settings window must
 * judge fine here, so the two implementations have to agree case for case.
 *
 * The default action is "systemone" (TypeSafe's native endpoint), matching
 * src/generate.py exactly. A base that already spells out its own version+action
 * path (e.g. Vercel's gateway alias "/v1/evaluate") is used verbatim — the rule
 * cannot tell an action segment from a namespace prefix, so whatever the user
 * already has there is trusted as-is, regardless of what word it uses.
 */

const ACTION = "systemone";
const VERSION_SEGMENT = /^v\d+[a-z]*$/i;

export function jevRequestUrl(base: string): string {
  const trimmed = (base ?? "").replace(/\/+$/, "");
  const segments = trimmed.split("/").slice(3).filter(Boolean);
  const last = segments[segments.length - 1];
  const secondLast = segments[segments.length - 2];

  // version + action already present (e.g. ".../v1/evaluate") — used verbatim
  if (segments.length >= 2 && secondLast !== undefined && VERSION_SEGMENT.test(secondLast)) {
    return trimmed;
  }
  // version segment only (e.g. ".../v1") — append just the action, never /v1/v1/...
  if (last !== undefined && VERSION_SEGMENT.test(last)) return `${trimmed}/${ACTION}`;
  // host only — append the full version + action path
  return `${trimmed}/v1/${ACTION}`;
}
