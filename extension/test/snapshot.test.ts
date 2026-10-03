import { test } from "node:test";
import assert from "node:assert/strict";
import {
  messageId, validateSnapshot, newestIncoming, type ConversationSnapshot,
} from "../src/contracts/snapshot.ts";

const ok: ConversationSnapshot = {
  source: "telegram",
  conversationId: "c1",
  title: "Team",
  isGroup: true,
  messages: [
    { id: "m1", text: "need the doc", sender: "Ana", isSelf: false, ts: 1758585600, mentionsMe: false },
    { id: "m2", text: "on it", isSelf: true, ts: 1758585660, mentionsMe: false },
  ],
  input: { canFill: true },
};

test("accepts a well-formed snapshot", () => {
  const r = validateSnapshot(ok);
  assert.equal(r.ok, true);
});

test("rejects a snapshot whose messages are not an array", () => {
  const r = validateSnapshot({ ...ok, messages: "nope" });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /messages/);
});

test("rejects a message with a non-three-valued isSelf", () => {
  const bad = { ...ok, messages: [{ ...ok.messages[0]!, isSelf: "yes" }] };
  const r = validateSnapshot(bad);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /isSelf/);
});

test("accepts a message with isSelf: null (direction unconfirmed)", () => {
  const s = { ...ok, messages: [{ ...ok.messages[0]!, isSelf: null }] };
  const r = validateSnapshot(s);
  assert.equal(r.ok, true);
});

test("rejects a message with a non-numeric ts", () => {
  const bad = { ...ok, messages: [{ ...ok.messages[0]!, ts: "bad" }] };
  const r = validateSnapshot(bad);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /ts/);
});

test("rejects a message with ts: NaN", () => {
  const bad = { ...ok, messages: [{ ...ok.messages[0]!, ts: NaN }] };
  const r = validateSnapshot(bad);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /ts/);
});

test("rejects a message with a non-boolean mentionsMe", () => {
  const bad = { ...ok, messages: [{ ...ok.messages[0]!, mentionsMe: "false" }] };
  const r = validateSnapshot(bad);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /mentionsMe/);
});

test("message ids are stable for the same content and position", () => {
  assert.equal(messageId("need the doc", 3, "Ana"), messageId("need the doc", 3, "Ana"));
});

test("message ids differ when position differs", () => {
  assert.notEqual(messageId("ok", 1), messageId("ok", 2));
});

test("newestIncoming skips my own messages", () => {
  assert.equal(newestIncoming(ok)?.id, "m1");
});

test("newestIncoming ignores unconfirmed direction", () => {
  const s: ConversationSnapshot = {
    ...ok,
    messages: [{ id: "m3", text: "who said this", isSelf: null, ts: 1, mentionsMe: false }],
  };
  assert.equal(newestIncoming(s), null);
});
