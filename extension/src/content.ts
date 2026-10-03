/**
 * The page-side eye. Reads the DOM through the picked adapter and posts the
 * result to background.ts — nothing else. Two hard rules, enforced by what
 * this file simply never does: it never writes to the page (no DOM mutation,
 * no dispatched input/keyboard events, no clipboard access) and it never logs
 * or forwards message text — only structural snapshots, structural
 * diagnostics, and short error strings that name a failure mode, not content.
 *
 * Injected on demand via chrome.scripting.executeScript, once per tab per
 * page-load, after the user has explicitly granted this origin through the
 * panel's "enable on this site" flow (see panel.ts) or — for an origin
 * already granted in an earlier session — automatically on the next full
 * navigation (see background.ts's tabs.onUpdated handler). Either path can
 * legitimately call this twice in edge cases (a slow permission dialog plus
 * a fast page reload, for instance), so the whole thing is guarded by a flag
 * on `window` to make re-injection a safe no-op rather than a second set of
 * observers and message listeners.
 */

import { pickAdapter } from "./adapters/registry.ts";
import { LayoutChangedError } from "./adapters/types.ts";

declare global {
  interface Window {
    __jevJarvisInjected?: boolean;
  }
}

const THROTTLE_MS = 500;

function main(): void {
  const adapter = pickAdapter(location.href);

  function send(message: unknown): void {
    // The background service worker is always registered before this script
    // can run (it owns the onMessage listener that would have relayed the
    // permission grant / injection in the first place), so this should not
    // normally reject — but a worker mid-restart is possible, and a content
    // script must never let a messaging failure surface as an uncaught
    // rejection in the host page's console.
    void chrome.runtime.sendMessage(message).catch(() => {});
  }

  function readErrorMessage(e: unknown): string {
    return e instanceof Error ? e.message : "read failed";
  }

  let lastPushAt = 0;
  let scheduled: ReturnType<typeof setTimeout> | null = null;

  function pushNow(): void {
    lastPushAt = Date.now();
    try {
      const snapshot = adapter.readSnapshot(document);
      send({ type: "snapshot", snapshot });
    } catch (e) {
      if (e instanceof LayoutChangedError) {
        send({ type: "readError", message: e.message });
        return;
      }
      send({ type: "readError", message: readErrorMessage(e) });
    }
  }

  // Leading + trailing throttle: the first mutation in a quiet period pushes
  // immediately, further mutations within the window collapse into a single
  // trailing push at the window's edge, so a burst of DOM churn (someone
  // typing, a virtualized list re-rendering) never posts more than once per
  // THROTTLE_MS and never silently drops the final state either.
  function schedulePush(): void {
    const elapsed = Date.now() - lastPushAt;
    if (elapsed >= THROTTLE_MS) {
      pushNow();
      return;
    }
    if (scheduled !== null) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      pushNow();
    }, THROTTLE_MS - elapsed);
  }

  const observer = new MutationObserver(() => schedulePush());
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  pushNow();

  chrome.runtime.onMessage.addListener((msg: unknown) => {
    const m = msg as { type?: unknown } | null;
    if (!m || m.type !== "requestDiagnostic") return;
    try {
      const diagnostic = adapter.diagnose(document);
      send({ type: "diagnostic", diagnostic });
    } catch (e) {
      // diagnose() is documented to never throw, but a content script must
      // never let an unexpected exception here go unreported — the panel's
      // diagnostic view is a first-class debugging surface, not a nice-to-have.
      send({ type: "readError", message: readErrorMessage(e) });
    }
  });
}

if (!window.__jevJarvisInjected) {
  window.__jevJarvisInjected = true;
  main();
}
