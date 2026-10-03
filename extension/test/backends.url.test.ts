import { test } from "node:test";
import assert from "node:assert/strict";
import { jevRequestUrl } from "../src/backends/url.ts";

// NOTE: the default action name below is "systemone", not "evaluate" — see
// task-7-report.md for why this deviates from the brief's literal test values.
// src/generate.py's jev_request_url (the named authority when the two disagree)
// only ever appends "/systemone"; "evaluate" is preserved verbatim exclusively
// when a base already spells out its own <version>/<action> path (Vercel's
// gateway alias), which is exactly what the last two cases below exercise.

test("host only gets the version and action appended", () => {
  assert.equal(jevRequestUrl("https://api.typesafe.ai"), "https://api.typesafe.ai/v1/systemone");
});

test("trailing slash does not double up", () => {
  assert.equal(jevRequestUrl("https://api.typesafe.ai/"), "https://api.typesafe.ai/v1/systemone");
});

test("a version segment gets only the action appended", () => {
  assert.equal(jevRequestUrl("https://api.typesafe.ai/v1"), "https://api.typesafe.ai/v1/systemone");
});

test("a non-v1 version segment is respected", () => {
  assert.equal(jevRequestUrl("https://gw.example.com/api/v4"),
    "https://gw.example.com/api/v4/systemone");
});

test("a full action path is used verbatim", () => {
  assert.equal(jevRequestUrl("https://ai-gateway.vercel.sh/v1/evaluate"),
    "https://ai-gateway.vercel.sh/v1/evaluate");
});

test("a full action path with trailing slash is normalised, not appended to", () => {
  assert.equal(jevRequestUrl("https://ai-gateway.vercel.sh/v1/evaluate/"),
    "https://ai-gateway.vercel.sh/v1/evaluate");
});
