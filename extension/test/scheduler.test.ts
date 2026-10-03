import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialState, decide, isStaleResult, resetFuse, type DecideInput,
} from "../src/scheduler/decide.ts";
import type { ConversationSnapshot } from "../src/contracts/snapshot.ts";

function snap(texts: [string, boolean | null][], id = "c1"): ConversationSnapshot {
  return {
    source: "s", conversationId: id, title: "t", isGroup: false,
    messages: texts.map(([text, isSelf], i) => ({
      id: `m${i}-${text}`, text, isSelf, ts: i, mentionsMe: false,
    })),
    input: { canFill: true },
  };
}

const at = (now: number, s: ConversationSnapshot, active = true): DecideInput =>
  ({ now, snapshot: s, tabActive: active });

/**
 * Actually floods a conversation past the fuse limit (21 arrivals within the 60 s
 * window) instead of hand-assembling a `{ fused: true }` state. A real trip leaves
 * `pendingId` pointing at the last flooding message and `recentArrivals` holding 21
 * timestamps — a hand-built state does not reproduce that shape.
 */
function floodToFuse(conversationId = "c1") {
  let messages: [string, boolean | null][] = [];
  let last = decide(initialState(), at(0, snap(messages, conversationId)));
  for (let i = 0; i < 21; i++) {
    messages = [...messages, [`m${i}`, false]];
    last = decide(last.state, at(1000 + i * 100, snap(messages, conversationId)));
  }
  return { state: last.state, action: last.action, messages };
}

test("a fresh incoming message waits for the settle window", () => {
  const s0 = initialState();
  const r = decide(s0, at(1000, snap([["need the doc", false]])));
  assert.equal(r.action.kind, "wait");
});

test("analyses once the settle window has passed", () => {
  let st = initialState();
  st = decide(st, at(1000, snap([["need the doc", false]]))).state;
  const r = decide(st, at(2300, snap([["need the doc", false]])));
  assert.equal(r.action.kind, "analyze");
});

test("a second message inside the settle window restarts it", () => {
  let st = initialState();
  st = decide(st, at(1000, snap([["one", false]]))).state;
  st = decide(st, at(1500, snap([["one", false], ["two", false]]))).state;
  assert.equal(decide(st, at(2200, snap([["one", false], ["two", false]]))).action.kind, "wait");
  const r = decide(st, at(2800, snap([["one", false], ["two", false]])));
  assert.equal(r.action.kind, "analyze");
  assert.equal(r.action.kind === "analyze" && r.action.message.text, "two");
});

test("the same message is never analysed twice", () => {
  let st = initialState();
  st = decide(st, at(1000, snap([["one", false]]))).state;
  st = decide(st, at(2300, snap([["one", false]]))).state;
  assert.equal(decide(st, at(3000, snap([["one", false]]))).action.kind, "idle");
});

test("my own reply clears the pending analysis", () => {
  let st = initialState();
  st = decide(st, at(1000, snap([["one", false]]))).state;
  const r = decide(st, at(1500, snap([["one", false], ["on it", true]])));
  assert.equal(r.action.kind, "idle");
});

test("an inactive tab never analyses", () => {
  let st = initialState();
  const r = decide(st, at(9000, snap([["one", false]]), false));
  assert.equal(r.action.kind, "idle");
});

test("switching conversation bumps the epoch so in-flight results are dropped", () => {
  let st = initialState();
  st = decide(st, at(1000, snap([["one", false]], "c1"))).state;
  const before = st.epoch;
  const r = decide(st, at(1100, snap([["hello", false]], "c2")));
  assert.notEqual(r.state.epoch, before);
});

test("more than 20 messages in a minute blows the fuse", () => {
  const last = floodToFuse();
  assert.equal(last.action.kind, "fuse");
});

test("a blown fuse stays blown until it is reset", () => {
  const flooded = floodToFuse("c1");
  assert.equal(decide(flooded.state, at(50_000, snap(flooded.messages, "c1"))).action.kind, "idle");
});

test("resetFuse lets the same conversation analyse again", () => {
  const flooded = floodToFuse("c1");
  let st = resetFuse(flooded.state);
  st = decide(st, at(4000, snap([["back on", false]], "c1"))).state;
  assert.equal(decide(st, at(5300, snap([["back on", false]], "c1"))).action.kind, "analyze");
});

test("switching away from a fused conversation and back keeps it fused", () => {
  const flooded = floodToFuse("c1");
  assert.equal(flooded.state.fused, true);

  // switch to an unrelated tab/conversation — it must not inherit the flag
  const away = decide(flooded.state, at(5000, snap([["hi", false]], "c2")));
  assert.equal(away.state.fused, false);

  // switch back to the still-flooded conversation, with no resetFuse() in between
  const back = decide(away.state, at(5100, snap(flooded.messages, "c1")));
  assert.equal(back.state.fused, true);
  assert.equal(back.action.kind, "idle");
});

test("switching to a genuinely different, unflooded conversation is not fused", () => {
  const flooded = floodToFuse("c1");
  const r = decide(flooded.state, at(5000, snap([["hello", false]], "c2")));
  assert.equal(r.state.fused, false);
  assert.equal(r.action.kind, "wait");
});

test("the minimum gap between two distinct analyses of one conversation is enforced", () => {
  let st = initialState();
  // "one" settles and is analysed at t=1300
  st = decide(st, at(100, snap([["one", false]]))).state;
  const first = decide(st, at(1300, snap([["one", false]])));
  assert.equal(first.action.kind, "analyze");
  st = first.state;

  // "two" arrives right after and settles at t=2600 — only 1300ms after the last
  // analysis, short of the 2000ms minimum gap, so it must keep waiting
  st = decide(st, at(1400, snap([["one", false], ["two", false]]))).state;
  const tooSoon = decide(st, at(2600, snap([["one", false], ["two", false]])));
  assert.equal(tooSoon.action.kind, "wait");

  // once 2000ms have elapsed since the last analysis, it goes through
  const r = decide(st, at(3300, snap([["one", false], ["two", false]])));
  assert.equal(r.action.kind, "analyze");
  assert.equal(r.action.kind === "analyze" && r.action.message.text, "two");
});

// ---------------------------------------------------------------------------
// 在途结果的两条作废条件（设计文档第 7 节）：切了会话、切了标签页
// ---------------------------------------------------------------------------

test("an in-flight result is kept when nothing changed under it", () => {
  assert.equal(isStaleResult({ resultTabId: 7, activeTabId: 7, resultEpoch: 3, currentEpoch: 3 }),
    false);
});

test("an in-flight result is dropped when the user switched tabs while it was out", () => {
  // 入站快照有 sender.tab.active 门控，但已经在飞的 judge() 没有——
  // 没有这条检查，A 标签页的判断会渲染进用户已经切过去的 B 标签页面板。
  assert.equal(isStaleResult({ resultTabId: 7, activeTabId: 9, resultEpoch: 3, currentEpoch: 3 }),
    true);
});

test("an in-flight result is dropped when the conversation changed under it", () => {
  assert.equal(isStaleResult({ resultTabId: 7, activeTabId: 7, resultEpoch: 3, currentEpoch: 4 }),
    true);
});

test("an in-flight result is dropped when the active tab is unknown", () => {
  assert.equal(isStaleResult({ resultTabId: 7, activeTabId: null, resultEpoch: 3, currentEpoch: 3 }),
    true);
});
