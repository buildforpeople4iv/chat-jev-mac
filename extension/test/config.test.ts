import { test } from "node:test";
import assert from "node:assert/strict";
import { pickBackendKind, DEFAULTS, type StoredConfig } from "../src/config.ts";

const base: StoredConfig = { ...DEFAULTS };

test("a jev key wins over a generic llm key", () => {
  assert.equal(pickBackendKind({ ...base, jevKey: "j", llmKey: "o" }), "jev");
});

test("falls back to the generic llm when only that key is set", () => {
  assert.equal(pickBackendKind({ ...base, jevKey: "", llmKey: "o" }), "llm");
});

test("no key at all is reported as none, not guessed", () => {
  assert.equal(pickBackendKind({ ...base, jevKey: "", llmKey: "" }), "none");
});

test("whitespace-only keys count as absent", () => {
  assert.equal(pickBackendKind({ ...base, jevKey: "   ", llmKey: "\t" }), "none");
});

test("defaults point at the endpoints the repo documents", () => {
  assert.equal(DEFAULTS.jevBase, "https://api.typesafe.ai");
  assert.equal(DEFAULTS.lang, "en");
});
