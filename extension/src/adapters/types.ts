/**
 * Contract 2 — the shape every site adapter (generic or site-specific) implements,
 * plus the pieces a site-specific adapter will need without pulling in the generic
 * heuristics: the `Measure` abstraction, `LayoutChangedError`, and the diagnostic
 * report shape.
 *
 * Kept separate from `generic.ts` on purpose: a future site-specific adapter
 * imports `SiteAdapter`, `Measure`, `domMeasure` and `LayoutChangedError` from
 * here without dragging in the generic adapter's heuristics.
 */

import type { ConversationSnapshot } from "../contracts/snapshot.ts";

/**
 * Geometry measurement, injectable so direction detection can be tested.
 *
 * jsdom has no layout engine — `getBoundingClientRect()` always returns zeros
 * there — so a direct call would make the bubble-side heuristic untestable
 * (and silently dead in the test suite). Tests inject a fake; the real DOM
 * uses `domMeasure`.
 */
export type Measure = (el: Element) => { left: number; right: number; width: number };

export const domMeasure: Measure = (el) => {
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, width: r.width };
};

/**
 * Thrown when an adapter cannot find a message container or the container has
 * no rows. This is distinct from "empty conversation" — a real empty chat still
 * has a container; a page whose layout no longer matches what the adapter
 * expects has neither, and callers should surface that as a layout change, not
 * silently show zero messages.
 */
export class LayoutChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayoutChangedError";
  }
}

/**
 * A descendant element's structure inside a reported row — no text, not even
 * a length. On real chat sites the stable "which side is this" marker often
 * sits on a nested wrapper (Slack's sender-metadata node, WhatsApp's
 * tail/avatar wrapper), not the row itself, so the diagnostic needs to show
 * shape a few levels down without ever showing content.
 */
export interface DescendantShape {
  tag: string;
  classes: string[];
  /** Only role / aria-* / data-*; aria-label and aria-description values are redacted. */
  attrs: Record<string, string>;
}

/** One row's structure, with every human-authored text value redacted to a length. */
export interface RedactedShape {
  tag: string;
  classes: string[];
  /** Only role / aria-* / data-*; aria-label and aria-description values are redacted. */
  attrs: Record<string, string>;
  textLength: number;
  childTags: string[];
  /** Bounded structural walk of this row's descendants — see `DescendantShape`. */
  descendants: DescendantShape[];
}

/**
 * How much to trust `counts`. "geometry" means both sides were actually
 * separated (some rows read as mine, some as theirs); "weak" means every row
 * that resolved landed on the same side, which is what a single-column layout
 * or a mis-scaled measurement looks like and is not evidence of anything;
 * "none" means nothing resolved at all.
 */
export type DirectionSignal = "site-marker" | "geometry" | "weak" | "none";

/**
 * A structure-only report of what an adapter saw on a page: container, row
 * shapes, direction signal, input detection. Never message text — this is
 * meant to be pasted by a user into a bug report or shared with a third
 * party, so a leak here is worse than a leak in a debug log.
 */
export interface AdapterDiagnostic {
  adapterId: string;
  host: string;
  probedAt: string;
  containerSelector: string | null;
  candidateContainers: { selector: string; childCount: number }[];
  rowCount: number;
  directionSignal: DirectionSignal;
  selfMarkerHint: string | null;
  rowShapes: RedactedShape[];
  inputFound: boolean;
  inputKind: "contenteditable" | "textarea" | null;
  counts: { self: number; them: number; unknown: number };
  notes: string[];
}

export interface SiteAdapter {
  id: string;
  /** ISO date (YYYY-MM-DD) the adapter's selectors were last confirmed against the live site. */
  probedAt: string;
  matches(url: string): boolean;
  readSnapshot(doc: Document, measure?: Measure): ConversationSnapshot;
  diagnose(doc: Document, measure?: Measure): AdapterDiagnostic;
}
