/**
 * The generic heuristic adapter: no site-specific selectors, just structural
 * signals any chat UI is likely to have (a repeated-row container, a
 * contenteditable or textarea composer, bubble geometry). It stands in for a
 * real site adapter until enough diagnostic reports come back from users to
 * write one, and it also implements `diagnose()`, the report those users send
 * back — see `types.ts` for why that report can never carry message text.
 */

import { describeElement, findMessageContainers, redactToken } from "../probe/collect.ts";
import type { ChatMessage, ConversationSnapshot } from "../contracts/snapshot.ts";
import { messageId } from "../contracts/snapshot.ts";
import type {
  AdapterDiagnostic,
  DescendantShape,
  DirectionSignal,
  Measure,
  RedactedShape,
  SiteAdapter,
} from "./types.ts";
import { domMeasure, LayoutChangedError } from "./types.ts";

export type { Measure } from "./types.ts";
export { domMeasure, LayoutChangedError } from "./types.ts";

// The date this heuristic module was written and last checked against the
// synthetic fixtures below. Not tied to any one live site — a genuine site
// adapter's `probedAt` instead records when its selectors were confirmed
// against the real page.
const GENERIC_PROBED_AT = "2026-09-23";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Direct children of `container` that carry visible text — the candidate message rows. */
function textRows(container: Element): Element[] {
  return Array.from(container.children).filter((c) => (c.textContent ?? "").trim().length > 0);
}

function resolveContainer(doc: Document): Element {
  const report = findMessageContainers(doc)[0];
  if (!report) throw new LayoutChangedError("no message container found");
  return report.element;
}

/** Where the message list sits in the viewport, and how wide it is. */
interface ContainerBox {
  left: number;
  width: number;
}

/**
 * Bubble-side geometry, ported from `perception.message_side()` (see
 * src/perception.py): normalize the row's left/right edges **to the container's
 * own coordinate system** and classify by how far the row leans to one side.
 * Deliberately conservative — a row that spans the middle or sits near-center
 * is left `null` rather than guessed, because a wrongly-labeled "me" message
 * can become a reply target for the user's own words.
 *
 * Subtracting `box.left` is load-bearing, not tidiness. `measure()` returns
 * viewport-absolute coordinates (getBoundingClientRect), while the Python
 * original is handed an x already normalized to the chat pane. Every real chat
 * site puts a conversation list to the left of the message pane, so without
 * the subtraction the whole scale shifts right by the sidebar's width: at a
 * 430px sidebar every incoming row reads as "unconfirmed" and at 600px every
 * row reads as "me" — i.e. the adapter cannot see an incoming message at all
 * on any site with a sidebar.
 *
 * A container width of 0 means measurement is unavailable (real DOM under
 * jsdom, or a page mid-layout) — return `null` rather than dividing by zero
 * or treating every row as glued to the left edge.
 */
function geometrySide(row: Element, measure: Measure, box: ContainerBox): boolean | null {
  if (box.width <= 0) return null;
  const { left, right } = measure(row);
  const x = (left - box.left) / box.width;
  const r = (right - box.left) / box.width;
  if (x >= 0.66 || (x >= 0.5 && r >= 0.8)) return true; // "me"
  if (x <= 0.5 && r < 0.8) return false; // "them"
  return null; // unconfirmed
}

function containerBox(container: Element, measure: Measure): ContainerBox {
  const { left, width } = measure(container);
  return { left, width };
}

/**
 * The conversation's identity, used by the scheduler to invalidate everything
 * in flight when the user switches chats (design doc, section 7).
 *
 * `pathname` alone is wrong on most target sites: Telegram Web keeps the
 * conversation in the hash (`/k/#-100123`), Slack and Discord in the path,
 * and WhatsApp Web nowhere at all — its URL is `https://web.whatsapp.com/`
 * for every chat. Search and hash are folded in here; WhatsApp stays
 * undetectable and is written down as a known limitation rather than papered
 * over with a guess (a title-based id would change on an unread-count blink).
 */
function conversationIdOf(doc: Document): string {
  const loc = doc.location;
  if (!loc) return "";
  return `${loc.pathname ?? ""}${loc.search ?? ""}${loc.hash ?? ""}`;
}

function findInput(doc: Document): { found: boolean; kind: "contenteditable" | "textarea" | null } {
  if (doc.querySelector('[contenteditable="true"]')) return { found: true, kind: "contenteditable" };
  if (doc.querySelector("textarea")) return { found: true, kind: "textarea" };
  return { found: false, kind: null };
}

function readSnapshot(doc: Document, measure: Measure = domMeasure): ConversationSnapshot {
  const container = resolveContainer(doc);
  const rows = textRows(container);
  // Unreachable under today's collect.ts: findMessageContainers() only ever
  // returns a container whose text-bearing children count is already >= 2
  // (see its own withText.length < 2 filter), so by the time resolveContainer
  // succeeds above, rows.length here can never be 0. Kept as a defensive
  // guard against that invariant changing later, and left untested for the
  // same reason — no fixture can reach it while that filter stands.
  if (rows.length === 0) throw new LayoutChangedError("message container has no rows");

  const box = containerBox(container, measure);

  const messages: ChatMessage[] = rows.map((row, index) => {
    const text = describeElement(row).text;
    return {
      // Counted from the *end* of the list, not the start. Slack, Discord and
      // Teams all virtualize: rows that scroll off the top are removed from
      // the DOM, which shifts every surviving row's distance-from-the-start
      // and hands already-analyzed messages a brand-new id — deduplication in
      // scheduler/decide.ts breaks and plain scrolling feeds the flood fuse.
      // Distance from the end is stable under top-trimming, and the newest
      // incoming message is the only one deduplication cares about.
      id: messageId(text, rows.length - 1 - index),
      text,
      // Sender attribution has no reliable generic signal (no site-specific
      // "who sent this" selector to read); guessing wrong is worse than
      // leaving it unset. A future site adapter reads it from its own markup.
      isSelf: geometrySide(row, measure, box),
      ts: 0,
      mentionsMe: false,
    };
  });

  const input = findInput(doc);

  return {
    source: "generic",
    conversationId: conversationIdOf(doc),
    title: doc.title,
    isGroup: false,
    messages,
    input: { canFill: input.found },
  };
}

// Keys whose *value* is human-authored text on real chat sites even though the
// key itself is structural. aria-label in particular is routinely the message
// text or the sender's name read aloud by a screen reader — keeping the key
// but redacting the value is the whole point of this list.
const REDACT_VALUE_ATTRS = new Set(["aria-label", "aria-description"]);

// data-* is a grab-bag, not a safe category: real chat sites embed the message
// text or sender name in attributes like WhatsApp's `data-pre-plain-text`
// (named explicitly in probe/collect.ts's anonymize() comment as a known
// offender). Only the two keys findMessageContainers' selectorFor() actually
// builds selectors from are trusted verbatim; every other data-* value is
// redacted the same way aria-label is, on the same "don't know, don't risk it"
// principle.
const LITERAL_DATA_ATTRS = new Set(["data-testid", "data-qa"]);

// Attribute values that survive the "always redact" list above are still
// page-author-controlled text, so they go through the same identifier test as
// a class token or an id (`redactToken`, probe/collect.ts) rather than being
// copied out verbatim: `aria-labelledby` and friends routinely point at an id,
// and an id is exactly where a site puts the peer's phone number.
function redactAttrValues(attrs: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    const lower = key.toLowerCase();
    const mustRedact = REDACT_VALUE_ATTRS.has(lower) || (lower.startsWith("data-") && !LITERAL_DATA_ATTRS.has(lower));
    result[key] = mustRedact ? `<len:${value.length}>` : redactToken(value);
  }
  return result;
}

// One redaction rule for class tokens, ids and structural attribute values —
// it lives in probe/collect.ts because the selector labels built there need it
// too. See the comment on `redactToken` for what passes and why.
function redactClasses(classes: string[]): string[] {
  return classes.map(redactToken);
}

// Bounds on the descendant walk below: deep/wide enough to reach a bubble's
// wrapper chain (Slack's sender-metadata node, WhatsApp's tail/avatar
// wrapper — the named examples of where the real direction marker lives),
// bounded so a virtualized row with hundreds of hidden siblings cannot
// explode the diagnostic's size.
const MAX_DESCENDANT_DEPTH = 3;
const MAX_DESCENDANTS_PER_ROW = 12;

/**
 * Structural-only walk of a row's descendants: tag, redacted classes, and the
 * same redacted structural attrs as the row itself — no text, not even a
 * length, at any depth. This is what lets a diagnostic surface a marker that
 * lives on a nested wrapper instead of the row element itself, without ever
 * showing what that wrapper says.
 */
function collectDescendantShapes(root: Element): DescendantShape[] {
  const out: DescendantShape[] = [];
  const walk = (el: Element, depth: number): void => {
    for (const child of Array.from(el.children)) {
      if (out.length >= MAX_DESCENDANTS_PER_ROW) return;
      const shape = describeElement(child);
      out.push({
        tag: shape.tag,
        classes: redactClasses(shape.classes),
        attrs: redactAttrValues(shape.attrs),
      });
      if (depth < MAX_DESCENDANT_DEPTH) walk(child, depth + 1);
    }
  };
  walk(root, 1);
  return out;
}

function redactShape(el: Element): RedactedShape {
  const shape = describeElement(el);
  return {
    tag: shape.tag,
    classes: redactClasses(shape.classes),
    attrs: redactAttrValues(shape.attrs),
    textLength: shape.text.length,
    childTags: Array.from(el.children).map((c) => c.tagName.toLowerCase()),
    descendants: collectDescendantShapes(el),
  };
}

function diagnose(doc: Document, measure: Measure = domMeasure): AdapterDiagnostic {
  const notes: string[] = [];
  const candidates = findMessageContainers(doc);
  const report = candidates[0] ?? null;
  // The element itself, never doc.querySelector(report.selector): the selector
  // is a redacted display label that may not even parse. See ContainerReport.
  const container = report?.element ?? null;

  if (!report) notes.push("no message container found");

  const rows = container ? textRows(container) : [];
  // Same unreachable-in-practice guard as readSnapshot() above; see the
  // comment there for why.
  if (container && rows.length === 0) notes.push("message container has no rows");

  const box = container ? containerBox(container, measure) : { left: 0, width: 0 };
  if (container && box.width <= 0) notes.push("container measured zero width; direction unavailable");

  // Direction ladder: site-marker (class/data-* corroborated by geometry) is
  // deliberately not implemented here — see the task report for why a marker
  // step risks locking onto an unrelated attribute (read receipts, unread
  // dividers, hover state) and confidently mislabeling a sender. Geometry is
  // the only signal this adapter reports.
  let self = 0;
  let them = 0;
  let unknown = 0;
  for (const row of rows) {
    const side = geometrySide(row, measure, box);
    if (side === true) self++;
    else if (side === false) them++;
    else unknown++;
  }
  // This label is the reader's confidence cue, so it must not say "geometry"
  // on the strength of one side alone. A conversation where every row lands on
  // the same side is exactly what a mis-scaled or single-column layout looks
  // like — the geometry "worked" and told us nothing. Only both sides being
  // present means the scale is actually separating senders.
  const directionSignal: DirectionSignal =
    self > 0 && them > 0 ? "geometry" : self + them > 0 ? "weak" : "none";

  const input = findInput(doc);

  return {
    adapterId: "generic",
    host: doc.location?.host ?? "",
    probedAt: todayISO(),
    containerSelector: report?.selector ?? null,
    candidateContainers: candidates.slice(0, 5).map((c) => ({ selector: c.selector, childCount: c.childCount })),
    rowCount: rows.length,
    directionSignal,
    selfMarkerHint: null,
    rowShapes: rows.slice(0, 5).map(redactShape),
    inputFound: input.found,
    inputKind: input.kind,
    counts: { self, them, unknown },
    notes,
  };
}

export const genericAdapter: SiteAdapter = {
  id: "generic",
  probedAt: GENERIC_PROBED_AT,
  matches: () => true,
  readSnapshot,
  diagnose,
};
