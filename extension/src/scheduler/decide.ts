/**
 * Scheduling decisions as one pure function: given the last state and what the page
 * looks like now, say whether to analyse. Keeping it pure is what makes the settle
 * window, deduplication, epoch guarding and the fuse testable without a browser.
 *
 * Constants come from the macOS app (src/hud.py), where they were tuned against a
 * live chat: 1.2 s settle, 2 s minimum gap between analyses of one conversation.
 */

import { newestIncoming, type ChatMessage, type ConversationSnapshot } from "../contracts/snapshot.ts";

export const SETTLE_MS = 1200;
export const MIN_GAP_MS = 2000;
export const FUSE_WINDOW_MS = 60_000;
export const FUSE_LIMIT = 20;

export interface SchedulerState {
  conversationId: string | null;
  epoch: number;
  pendingId: string | null;
  pendingSince: number;
  analyzedId: string | null;
  lastAnalyzedAt: number;
  recentArrivals: number[];
  fused: boolean;
  /**
   * Which conversation the fuse belongs to. A conversation switch must not be able to
   * un-blow the fuse for free: `fused` is recomputed from this on every switch, so
   * switching away and back to the same flooded conversation keeps it blown, while
   * switching to a genuinely different conversation does not inherit the flag.
   */
  fusedConversationId: string | null;
}

export interface DecideInput {
  now: number;
  snapshot: ConversationSnapshot;
  tabActive: boolean;
}

export type Action =
  | { kind: "idle" }
  | { kind: "wait" }
  | { kind: "analyze"; message: ChatMessage; epoch: number }
  | { kind: "fuse" };

export function initialState(): SchedulerState {
  return {
    conversationId: null,
    epoch: 0,
    pendingId: null,
    pendingSince: 0,
    analyzedId: null,
    lastAnalyzedAt: -Infinity,
    recentArrivals: [],
    fused: false,
    fusedConversationId: null,
  };
}

export function decide(
  prev: SchedulerState, input: DecideInput,
): { state: SchedulerState; action: Action } {
  const { now, snapshot, tabActive } = input;
  let state = { ...prev };

  // a different conversation invalidates everything in flight — except the fuse's memory
  // of which conversation tripped it. That has to survive the switch, or switching away
  // and back to the same flooded conversation would un-blow it for free (zero elapsed
  // time, no explicit resetFuse()). `fused` itself is recomputed from that memory: true
  // only if we've switched back to the very conversation that blew it.
  if (state.conversationId !== snapshot.conversationId) {
    const fusedConversationId = prev.fusedConversationId;
    state = {
      ...initialState(),
      epoch: prev.epoch + 1,
      conversationId: snapshot.conversationId,
      fusedConversationId,
      fused: fusedConversationId !== null && fusedConversationId === snapshot.conversationId,
    };
  }

  if (!tabActive) return { state, action: { kind: "idle" } };
  // a blown fuse stops everything for this conversation until the panel resets it.
  // This check has to come before the pending/settle branches below, otherwise a fused
  // conversation keeps arming new pending messages and never actually goes quiet.
  if (state.fused) return { state, action: { kind: "idle" } };

  const target = newestIncoming(snapshot);
  if (!target) return { state: { ...state, pendingId: null }, action: { kind: "idle" } };

  // my own message after theirs means I already replied — drop the pending analysis
  const last = snapshot.messages[snapshot.messages.length - 1];
  if (last && last.isSelf === true) {
    return { state: { ...state, pendingId: null }, action: { kind: "idle" } };
  }

  if (state.analyzedId === target.id) return { state, action: { kind: "idle" } };

  if (state.pendingId !== target.id) {
    const arrivals = [...state.recentArrivals, now].filter((t) => now - t < FUSE_WINDOW_MS);
    if (arrivals.length > FUSE_LIMIT) {
      return { state: { ...state, recentArrivals: arrivals, fused: true,
                         fusedConversationId: state.conversationId },
               action: { kind: "fuse" } };
    }
    return {
      state: { ...state, pendingId: target.id, pendingSince: now, recentArrivals: arrivals },
      action: { kind: "wait" },
    };
  }

  if (now - state.pendingSince < SETTLE_MS) return { state, action: { kind: "wait" } };
  if (now - state.lastAnalyzedAt < MIN_GAP_MS) return { state, action: { kind: "wait" } };

  return {
    state: { ...state, analyzedId: target.id, lastAnalyzedAt: now, pendingId: null },
    action: { kind: "analyze", message: target, epoch: state.epoch },
  };
}

/**
 * The two invalidation conditions the design doc (section 7) adds on top of the
 * macOS app's: **the conversation changed, or the tab changed**, while an
 * analysis was in flight. Both are checked when the result comes back, not when
 * it is dispatched — that is the whole point, the result outlives the state it
 * was asked about.
 *
 * Kept here, pure, because background.ts is the one module with no test harness
 * (it is all chrome.* listeners), and this is the part of it that has a right
 * and a wrong answer. `activeTabId === null` counts as stale: we no longer know
 * which tab the user is looking at, and rendering into the wrong conversation
 * is worse than rendering nothing.
 */
export function isStaleResult(r: {
  resultTabId: number;
  activeTabId: number | null;
  resultEpoch: number;
  currentEpoch: number;
}): boolean {
  if (r.activeTabId === null) return true;
  if (r.resultTabId !== r.activeTabId) return true;
  return r.resultEpoch !== r.currentEpoch;
}

/** The panel's "resume" button: this conversation stops fusing for this tab's lifetime. */
export function resetFuse(state: SchedulerState): SchedulerState {
  return { ...state, fused: false, fusedConversationId: null, recentArrivals: [] };
}
