import { test } from "node:test";
import assert from "node:assert/strict";
import { intents, riskLevels, actions, tones, fallbackIntent } from "../src/definitions.ts";

test("both languages carry the same number of intents", () => {
  // 键不要求相同：中英各自的键就是各自面板上显示的意图名
  assert.equal(Object.keys(intents("en")).length, Object.keys(intents("zh")).length);
});

test("the fallback intent is itself a known intent in both languages", () => {
  for (const lang of ["zh", "en"] as const) {
    assert.ok(fallbackIntent(lang) in intents(lang));
  }
});

test("risk scale is ten levels in both languages", () => {
  assert.equal(riskLevels("zh").length, 10);
  assert.equal(riskLevels("en").length, 10);
});

test("every intent has actions in both languages", () => {
  for (const lang of ["zh", "en"] as const) {
    assert.deepEqual(Object.keys(actions(lang)).sort(), Object.keys(intents(lang)).sort());
  }
});

test("english tones are available for the skeleton", () => {
  assert.ok(Object.keys(tones("en")).length >= 3);
});
