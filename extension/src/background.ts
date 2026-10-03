/**
 * The one process that owns scheduler state and talks to the analysis backend.
 * content.ts and panel.ts are both deliberately thin — every decision (which
 * backend, whether to analyze, what is safe to replay to a panel that just
 * opened) lives here. See the message protocol in the task brief:
 *
 *   content -> background: snapshot, diagnostic, readError
 *   background -> panel:   verdict, status, fused, diagnostic
 *   panel -> background:   resetFuse, requestDiagnostic
 *
 * Two extensions beyond that literal list, both additive (existing readers of
 * a message can ignore the extra field / extra case and see the documented
 * shape exactly):
 *  - "status" and "verdict" carry an optional `title` (the conversation's
 *    title) so the panel's "analysis results" section can show a conversation
 *    name — the protocol as given carries no field that could supply it.
 *  - "requestDiagnostic" carries an optional `windowId` (the side panel's own
 *    window) so background can resolve "the current tab" relative to the
 *    window the panel is actually attached to, not whichever window last had
 *    focus browser-wide.
 */

import { loadConfig, pickBackendKind } from "./config.ts";
import { JevBackend } from "./backends/jev.ts";
import { LlmBackend } from "./backends/llm.ts";
import type { AnalysisBackend, Verdict } from "./backends/types.ts";
import {
  decide, initialState, isStaleResult, resetFuse, type SchedulerState,
} from "./scheduler/decide.ts";
import { validateSnapshot } from "./contracts/snapshot.ts";
import type { AdapterDiagnostic } from "./adapters/types.ts";

let state: SchedulerState = initialState();

// Everything below is a single global slot, not a per-tab map, mirroring the
// scheduler itself (SchedulerState is one stream, "the current active tab's
// current conversation" — see the design doc, section 7). That is a known,
// accepted limitation for a single browser window with one active tab; two
// browser windows each showing a different chat at once is not handled
// correctly (see the task report). Each slot below is tagged with the tabId
// it came from so a stale slot from a tab the user has switched away from is
// never replayed to a panel asking about a *different* tab.
let lastActiveTabId: number | null = null;
/**
 * The tab the user is looking at *right now* — distinct from `lastActiveTabId`,
 * which records which tab the cached verdict/status below belongs to. An
 * analysis that is still in flight when the user switches tabs must be dropped
 * rather than rendered into the panel of a conversation it says nothing about
 * (design doc section 7: switching tabs invalidates in-flight work). Kept fresh
 * by tabs.onActivated as well as by incoming snapshots, because a switch to a
 * tab with no content script produces no snapshot at all.
 */
let activeTabId: number | null = null;
let lastVerdict: { verdict: Verdict; epoch: number } | null = null;
let lastStatus: string | null = null;
let lastTitle: string | null = null;
let lastDiagnosticTabId: number | null = null;
let lastDiagnostic: AdapterDiagnostic | null = null;

/**
 * Best-effort broadcast to the panel. The panel is very often not open —
 * that is the normal case, not an error — and chrome.runtime.sendMessage
 * rejects with "Could not establish connection. Receiving end does not
 * exist." whenever nothing is listening. Swallow it here, once, rather than
 * letting every call site remember to.
 */
function notifyPanel(message: unknown): void {
  void chrome.runtime.sendMessage(message).catch(() => {});
}

async function backend(): Promise<AnalysisBackend | null> {
  const cfg = await loadConfig();
  const kind = pickBackendKind(cfg);
  if (kind === "jev") {
    return new JevBackend({ base: cfg.jevBase, key: cfg.jevKey, model: cfg.jevModel, lang: cfg.lang });
  }
  if (kind === "llm") {
    return new LlmBackend({ base: cfg.llmBase, key: cfg.llmKey, model: cfg.llmModel, lang: cfg.lang });
  }
  return null;
}

async function handleSnapshot(tabId: number, raw: unknown): Promise<void> {
  try {
    const checked = validateSnapshot(raw);
    if (!checked.ok) {
      lastActiveTabId = tabId;
      lastStatus = `bad snapshot: ${checked.error}`;
      notifyPanel({ type: "status", text: lastStatus, title: lastTitle ?? undefined });
      return;
    }

    const snapshot = checked.snapshot;
    if (snapshot.conversationId !== state.conversationId) {
      lastTitle = snapshot.title;
    }
    lastActiveTabId = tabId;
    // A snapshot only reaches here from a tab chrome reported as active, so this
    // is also the freshest possible answer to "which tab is the user on" — and
    // the one that is right immediately after a service-worker restart, before
    // any tabs.onActivated has fired.
    activeTabId = tabId;

    const result = decide(state, { now: Date.now(), snapshot, tabActive: true });
    state = result.state;

    if (result.action.kind === "fuse") {
      notifyPanel({ type: "fused" });
      return;
    }
    if (result.action.kind !== "analyze") return;

    const { message, epoch } = result.action;
    const be = await backend();
    if (!be) {
      lastStatus = "no API key configured";
      notifyPanel({ type: "status", text: lastStatus, title: lastTitle ?? undefined });
      return;
    }
    lastStatus = "judging…";
    notifyPanel({ type: "status", text: lastStatus, title: lastTitle ?? undefined });
    try {
      const verdict = await be.judge({ text: message.text, context: null });
      // Stale in either of the two ways section 7 names: the conversation
      // changed (epoch bumped) or the user switched tabs while we waited.
      if (isStaleResult({ resultTabId: tabId, activeTabId, resultEpoch: epoch,
                          currentEpoch: state.epoch })) return;
      lastVerdict = { verdict, epoch };
      lastStatus = null;
      notifyPanel({ type: "verdict", verdict, epoch, title: lastTitle ?? undefined });
    } catch (e) {
      // Same staleness test as the success path: a failure that belongs to a
      // conversation the user has left is not news they can act on.
      if (isStaleResult({ resultTabId: tabId, activeTabId, resultEpoch: epoch,
                          currentEpoch: state.epoch })) return;
      // Never forward e's message verbatim if it could conceivably echo request
      // content back (it can't here — judge() failures are network/HTTP shaped,
      // e.g. "429 from api.typesafe.ai" — but keep the fallback text generic too.
      lastStatus = e instanceof Error ? e.message : "judge failed";
      notifyPanel({ type: "status", text: lastStatus, title: lastTitle ?? undefined });
    }
  } catch (e) {
    // Outer safety net: anything above that isn't the judge() call itself can
    // still throw (loadConfig()'s chrome.storage.local.get during a
    // service-worker teardown, for instance). This is called fire-and-forget
    // from the onMessage listener (`void handleSnapshot(...)`), so without
    // this catch such a failure would surface as an unhandled promise
    // rejection instead of a status the user can see.
    lastActiveTabId = tabId;
    lastStatus = e instanceof Error ? e.message : "analysis failed";
    notifyPanel({ type: "status", text: lastStatus, title: lastTitle ?? undefined });
  }
}

async function handleRequestDiagnostic(windowId: number | undefined): Promise<void> {
  try {
    const query: chrome.tabs.QueryInfo = windowId !== undefined
      ? { active: true, windowId }
      : { active: true, lastFocusedWindow: true };
    const [tab] = await chrome.tabs.query(query);
    const tabId = tab?.id;

    // Replay whatever we already know — the panel may have opened after the
    // events that produced this state already fired once — but only for the
    // tab this request is actually about. A verdict/diagnostic cached from a
    // tab the user has since switched away from must never be shown as if it
    // were about the newly active one.
    if (tabId !== undefined && tabId === lastDiagnosticTabId && lastDiagnostic) {
      notifyPanel({ type: "diagnostic", diagnostic: lastDiagnostic });
    }
    if (tabId !== undefined && tabId === lastActiveTabId) {
      if (lastVerdict) {
        notifyPanel({ type: "verdict", verdict: lastVerdict.verdict, epoch: lastVerdict.epoch,
                      title: lastTitle ?? undefined });
      }
      if (state.fused) notifyPanel({ type: "fused" });
      else if (lastStatus) notifyPanel({ type: "status", text: lastStatus, title: lastTitle ?? undefined });
    }

    if (tabId === undefined) return;
    try {
      // Rejects when no content script is running on that tab yet (site not
      // enabled, or the active tab isn't a chat page at all) — nothing to relay.
      await chrome.tabs.sendMessage(tabId, { type: "requestDiagnostic" });
    } catch {
      // expected and silent, see above
    }
  } catch (e) {
    // Outer safety net, same rationale as handleSnapshot's: this runs
    // fire-and-forget (`void handleRequestDiagnostic(...)`) from the onMessage
    // listener, and chrome.tabs.query() above is not otherwise guarded — a
    // rejection there (e.g. the referenced window closed between the panel's
    // request and this call) must not become an unhandled rejection.
    notifyPanel({ type: "status", text: e instanceof Error ? e.message : "diagnostic request failed" });
  }
}

chrome.runtime.onMessage.addListener((msg: unknown, sender) => {
  const m = msg as { type?: unknown; [key: string]: unknown } | null;
  if (!m || typeof m.type !== "string") return;

  // Messages from the panel: an extension page, never a content script, so
  // chrome tags it with no sender.tab.
  if (sender.tab === undefined) {
    if (m.type === "resetFuse") {
      state = resetFuse(state);
      return;
    }
    if (m.type === "requestDiagnostic") {
      void handleRequestDiagnostic(typeof m["windowId"] === "number" ? (m["windowId"] as number) : undefined);
      return;
    }
    return;
  }

  // Messages from a content script.
  const tabId = sender.tab.id;
  if (tabId === undefined) return;
  const tabActive = sender.tab.active === true;

  if (m.type === "snapshot") {
    // Background tabs keep running their MutationObserver (a chat page never
    // knows it has been backgrounded), but only the active tab's traffic may
    // drive the scheduler — see design doc section 7. Letting an inactive
    // tab's snapshot through here would corrupt `state` for the tab the user
    // is actually looking at (decide() resets on any conversationId change,
    // active or not).
    if (!tabActive) return;
    void handleSnapshot(tabId, m["snapshot"]);
    return;
  }
  if (m.type === "diagnostic") {
    lastDiagnosticTabId = tabId;
    lastDiagnostic = m["diagnostic"] as AdapterDiagnostic;
    notifyPanel({ type: "diagnostic", diagnostic: lastDiagnostic });
    return;
  }
  if (m.type === "readError") {
    if (!tabActive) return;
    lastActiveTabId = tabId;
    lastStatus = typeof m["message"] === "string" ? m["message"] : "layout changed";
    notifyPanel({ type: "status", text: lastStatus, title: lastTitle ?? undefined });
    return;
  }
});

// The classic (non-setPanelBehavior) way to bind the toolbar icon to opening
// the side panel. sidePanel.open() must be called synchronously within a
// user-gesture event handler — it is here, directly inside onClicked.
chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId === undefined) return;
  // sidePanel.open() can reject (e.g. a window that closed between the click
  // and this call) — nothing meaningful to do about it, but it must not
  // become an unhandled rejection.
  void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

const HTTP_ORIGIN = /^https?:$/;

function originPattern(url: string): string | null {
  try {
    const u = new URL(url);
    if (!HTTP_ORIGIN.test(u.protocol)) return null;
    return `${u.origin}/*`;
  } catch {
    return null;
  }
}

/**
 * Re-inject on an origin the user already approved in a previous session.
 * chrome.scripting.executeScript is never called for an origin that has not
 * passed chrome.permissions.contains — an unapproved site gets zero script,
 * on this path exactly as on the panel's manual "enable" path. This only
 * saves the user from re-clicking "enable" after every full page reload of a
 * site they already said yes to; it grants no new access.
 */
async function maybeAutoInject(tabId: number, url: string | undefined): Promise<void> {
  if (!url) return;
  const pattern = originPattern(url);
  if (!pattern) return;
  try {
    const has = await chrome.permissions.contains({ origins: [pattern] });
    if (!has) return;
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch {
    // permissions.contains rejecting, or executeScript failing on a page it
    // cannot run on (chrome web store, etc.) — this is a silent convenience
    // feature with no pending user action to report the failure to; worst
    // case the user re-enables the site manually via the panel's button.
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") void maybeAutoInject(tabId, tab.url);
});

// Tab switches are one of the two invalidation conditions (design doc section
// 7). Inbound snapshots are already gated on sender.tab.active, but a judge()
// call that was already in flight when the user switched has no such gate —
// without this listener its result lands in the panel of whatever conversation
// the user moved to. Note this fires for every window, not just the one the
// panel is attached to; that matches the single-global-slot model documented
// above, where "the active tab" is browser-wide.
chrome.tabs.onActivated.addListener((activeInfo) => {
  activeTabId = activeInfo.tabId;
});
