/**
 * Probe collector: run this on a real chat page and it reports what an adapter
 * would need — which element holds the message list, what each row looks like,
 * and an anonymized HTML snapshot to use as an offline test fixture.
 *
 * It reads the page and nothing else: no network, no writes, no clicks.
 */

export interface ElementShape {
  tag: string;
  classes: string[];
  attrs: Record<string, string>;
  text: string;
}

export interface ContainerReport {
  /**
   * The container itself. Consumers must use this and never re-resolve
   * `selector` through `querySelector`: the selector is a redacted,
   * human-readable label, it is not guaranteed to be a legal CSS selector,
   * and when several elements share a shape it does not identify *which* one
   * scored best. Both failures were real — a numeric `id` produced
   * `#1099511627776`, which throws `SyntaxError`, and a page with two
   * `[role="log"]` elements resolved to the wrong one.
   */
  element: Element;
  /** Display only — already redacted (see `redactToken`). Never re-parsed. */
  selector: string;
  childCount: number;
  // Deliberately no `childShapes` here any more. It carried ElementShape.text,
  // i.e. unredacted message text, and its only consumer was the cancelled
  // console probe (src/probe/entry.ts, deleted). A field of real chat content
  // sitting on the object that feeds the shareable diagnostic is an accident
  // waiting for one careless spread; shapes are still available per row via
  // describeElement() where the caller can redact them.
}

const STRUCTURAL_ATTRS = /^(role|aria-|data-)/;

/**
 * `el.textContent` concatenates adjacent child nodes with no separator, so
 * `<span>Ana</span><span>hey there</span>` (no whitespace between the tags in
 * the source) reads back as "Anahey there" instead of "Ana hey there". Adapters
 * need a human-readable join, so text is gathered per child node and joined
 * with a space instead of taken straight off textContent.
 */
function extractText(node: Node): string {
  const parts: string[] = [];
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      const val = (child.nodeValue ?? "").trim();
      if (val) parts.push(val);
    } else if (child.nodeType === 1) {
      const val = extractText(child);
      if (val) parts.push(val);
    }
  }
  return parts.join(" ");
}

export function describeElement(el: Element): ElementShape {
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) {
    if (STRUCTURAL_ATTRS.test(a.name)) attrs[a.name] = a.value;
  }
  return {
    tag: el.tagName.toLowerCase(),
    classes: Array.from(el.classList),
    attrs,
    text: extractText(el).replace(/\s+/g, " ").trim(),
  };
}

// A class token, an id or a structural attribute value is the primary selector
// signal a future site adapter needs, so it is kept by default. But all three
// are page-author-controlled text, not a fixed vocabulary — CSS-in-JS content
// hashing, or a site that keys a row off the peer's phone number, can put
// content-derived strings there. One rule covers all three (the diagnostic
// that carries them is meant to be pasted to a third party):
//
//   * shaped like an ordinary CSS identifier (letters/digits/_/:/- only), and
//   * no longer than 64 characters, and
//   * no run of 7+ digits
//
// passes through verbatim; anything else is replaced by its length. The digit
// rule is what keeps `#chat-with-15551234567` — an id shaped exactly like a
// legal identifier — from carrying a phone number into a shared report; a long
// digit run is an account/phone/thread number, never a structural name, and a
// numeric id is page-instance-specific so nothing is lost by hiding it.
//
// Residual risk, accepted deliberately: a *short*, identifier-shaped token
// that embeds real content (e.g. a slug-like `msg-hey-there`) still passes
// through. Closing that would need language detection or a content blocklist,
// which is out of scope — selectors need names, and "looks like a CSS
// identifier" is what "structural, not authored prose" means here.
const SAFE_TOKEN = /^[A-Za-z0-9_:-]+$/;
const MAX_TOKEN_LEN = 64;
const LONG_DIGIT_RUN = /\d{7,}/;

export function redactToken(token: string): string {
  if (token.length <= MAX_TOKEN_LEN && SAFE_TOKEN.test(token) && !LONG_DIGIT_RUN.test(token)) {
    return token;
  }
  return `<len:${token.length}>`;
}

/**
 * A short, human-readable label for an element — for a diagnostic report and
 * for a person writing a site adapter later. It is *not* a handle: every value
 * in it is redacted (see `redactToken`), and `#1099511627776` is not even a
 * legal selector. Resolve `ContainerReport.element` instead.
 */
function selectorFor(el: Element): string {
  const role = el.getAttribute("role");
  if (role) return `[role="${redactToken(role)}"]`;
  const testid = el.getAttribute("data-testid") ?? el.getAttribute("data-qa");
  if (testid) return `[data-testid="${redactToken(testid)}"]`;
  if (el.id) return `#${redactToken(el.id)}`;
  const cls = Array.from(el.classList)[0];
  return cls ? `${el.tagName.toLowerCase()}.${redactToken(cls)}` : el.tagName.toLowerCase();
}

/**
 * Candidate message lists, best first. The signal is repetition: a message list is
 * the element with the most same-shaped children carrying text. Wrappers score lower
 * because their children differ from one another.
 *
 * Repetition alone is not enough, because a conversation list repeats too — and
 * on a WhatsApp-shaped page the sidebar has 25 rows while the open conversation
 * has 4, so "most children" picks the contact list and the adapter reads contact
 * previews as if they were messages. An explicit `role="log"` (ARIA's role for
 * exactly this: a live region new entries are appended to) therefore outranks
 * child count. It is not present on every site — see extension/README.md's known
 * limitations — so the full ranked list is reported and the panel shows it.
 */
export function findMessageContainers(doc: Document): ContainerReport[] {
  const scored: { report: ContainerReport; isLog: boolean }[] = [];
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    const kids = Array.from(el.children);
    if (kids.length < 2) continue;
    const withText = kids.filter((k) => (k.textContent ?? "").trim().length > 0);
    if (withText.length < 2) continue;
    const shapes = withText.map(describeElement);
    const signatures = new Set(shapes.map((s) => `${s.tag}.${s.classes[0] ?? ""}`));
    // every row looking alike is the tell; a wrapper's children look different
    if (signatures.size > Math.max(2, withText.length / 2)) continue;
    scored.push({
      report: {
        element: el,
        selector: selectorFor(el),
        childCount: withText.length,
      },
      isLog: el.getAttribute("role") === "log",
    });
  }
  scored.sort((a, b) => Number(b.isLog) - Number(a.isLog) || b.report.childCount - a.report.childCount);
  return scored.map((s) => s.report);
}

// Attributes whose values are selectors/enums, not human-authored text, and
// that a later adapter task needs literally (e.g. `[data-testid="..."]`
// selector construction, or `class="row in"` structural matching).
// Everything else is scrubbed: real chat sites routinely carry message text
// or sender names in `title`, `aria-label`, `alt`, `placeholder`, `value`, or
// WhatsApp-style `data-pre-plain-text` attributes, and those snapshots end up
// committed to a public repo.
const LITERAL_ATTRS = new Set([
  "class",
  "id",
  "role",
  "contenteditable",
  "type",
  "tabindex",
  "dir",
  "data-testid",
  "data-qa",
]);

function scrub(raw: string): string {
  return raw.replace(/\S/g, "x");
}

function scrubAttributes(el: Element): void {
  for (const attr of Array.from(el.attributes)) {
    if (LITERAL_ATTRS.has(attr.name.toLowerCase())) continue;
    if (attr.value) el.setAttribute(attr.name, scrub(attr.value));
  }
}

/**
 * A `<template>` element's markup lives in a separate `.content`
 * DocumentFragment, not in `childNodes` — `cloneNode(true)` still deep-clones
 * it (per the HTML "clone a node" steps) and `outerHTML` serialization
 * inlines it right back in, so anything left inside a template would
 * otherwise ride along untouched by a childNodes-only walk. Detected via
 * `nodeType === 11` (DOCUMENT_FRAGMENT_NODE) rather than
 * `instanceof DocumentFragment`, because this module also runs under plain
 * Node during tests, where no such global constructor exists — nodeType is
 * a plain number, portable between jsdom and a real browser.
 */
function templateContentOf(el: Element): DocumentFragment | null {
  const content = (el as unknown as { content?: Node }).content;
  return content && content.nodeType === 11 ? (content as DocumentFragment) : null;
}

/**
 * Structure-preserving anonymization: every text node becomes filler of the same
 * length. Selectors, classes and layout survive; the conversation does not.
 *
 * Text nodes are not the only place real content hides, so this also blanks
 * non-structural attribute values (title/aria-label/alt/placeholder/value/...)
 * and HTML comments — neither is reachable by only walking childNodes and
 * checking for text nodes, since attribute values live on the element itself
 * and a Comment node's text lives in its own nodeValue with no child text
 * node to catch it — and it descends into `<template>` content, which lives
 * outside `childNodes` entirely.
 */
export function anonymize(root: Element): string {
  const clone = root.cloneNode(true) as Element;
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        // Text node: nodeValue is the visible text itself.
        const raw = child.nodeValue ?? "";
        child.nodeValue = scrub(raw);
      } else if (child.nodeType === 8) {
        // Comment node: has no childNodes to recurse into, so its own
        // nodeValue must be scrubbed directly or it survives verbatim.
        child.nodeValue = scrub(child.nodeValue ?? "");
      } else {
        if (child.nodeType === 1) {
          scrubAttributes(child as Element);
          const templateContent = templateContentOf(child as Element);
          if (templateContent) walk(templateContent);
        }
        walk(child);
      }
    }
  };
  scrubAttributes(clone);
  const rootTemplateContent = templateContentOf(clone);
  if (rootTemplateContent) walk(rootTemplateContent);
  walk(clone);
  return clone.outerHTML;
}
