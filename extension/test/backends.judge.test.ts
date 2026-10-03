import { test } from "node:test";
import assert from "node:assert/strict";
import { JevBackend } from "../src/backends/jev.ts";
import { LlmBackend } from "../src/backends/llm.ts";

function fakeFetch(payload: unknown, capture?: (body: unknown) => void) {
  return async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (capture && init?.body) capture(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(payload), { status: 200 });
  };
}

test("jev judge maps the evaluate response onto a verdict", async () => {
  // NOTE: lang is "zh" here, not the brief's literal "en" — see task-7-report.md.
  // The mocked choice "催进度" is a Chinese intents() key; under lang: "en" the
  // guard (correctly) can't find it in the English table and falls back, which
  // contradicts this test's own assertions below. "zh" is the self-consistent
  // reading: a happy-path echo of a valid choice back through the language whose
  // criteria produced it.
  const backend = new JevBackend({
    base: "https://api.typesafe.ai", key: "k", model: "jev-latest", lang: "zh",
    fetchImpl: fakeFetch({
      answers: {
        intent: { choice: "催进度", confidence: 0.81, probabilities: { "催进度": 0.81 } },
        risk: { score: 4.2, probabilities: { "4": 0.5 } },
      },
    }),
  });
  const v = await backend.judge({ text: "any update?", context: null });
  assert.equal(v.intent, "催进度");
  assert.equal(v.confidence, 0.81);
  assert.equal(v.risk, 4.2);
  assert.ok(v.actions.length > 0, "actions come from the shared definitions");
});

test("jev judge falls back to the language's own catch-all label", async () => {
  const backend = new JevBackend({
    base: "https://api.typesafe.ai", key: "k", model: "m", lang: "en",
    fetchImpl: fakeFetch({ answers: { intent: { choice: "???" }, risk: { score: 0 } } }),
  });
  const v = await backend.judge({ text: "hi", context: null });
  assert.equal(v.intent, "chat");   // 不是 闲聊：英文面板不该冒出中文标签
});

test("jev sends english criteria when lang is en", async () => {
  let sent: unknown;
  const backend = new JevBackend({
    base: "https://api.typesafe.ai", key: "k", model: "m", lang: "en",
    fetchImpl: fakeFetch({ answers: {} }, (b) => { sent = b; }),
  });
  await backend.judge({ text: "hi", context: null });
  const criteria = (sent as { questions: { intent: { criteria: Record<string, string> } } })
    .questions.intent.criteria;
  assert.match(Object.values(criteria)[0]!, /they are/);
});

test("jev ranks candidates by probability, highest first", async () => {
  const backend = new JevBackend({
    base: "https://api.typesafe.ai", key: "k", model: "m", lang: "en",
    fetchImpl: fakeFetch({ answers: { best: { probabilities: { a: 0.2, b: 0.7 } } } }),
  });
  const ranked = await backend.rank({ text: "m", intent: "chat", candidates: ["a", "b"] });
  assert.deepEqual(ranked.map((r) => r.text), ["b", "a"]);
});

test("llm judge parses a single-letter answer into an intent", async () => {
  const backend = new LlmBackend({
    base: "https://api.deepseek.com", key: "k", model: "deepseek-chat", lang: "en",
    fetchImpl: fakeFetch({ choices: [{ message: { content: "(B)" } }] }),
  });
  const v = await backend.judge({ text: "any update?", context: null });
  assert.equal(v.intent, Object.keys((await import("../src/definitions.ts")).intents("en"))[1]);
});

test("llm judge is not fooled by the letters in the word Answer", async () => {
  // Python 侧实测过这个坑：没有前后界判定时，"Answer: (D)" 会匹配到 Answer 的 A
  const backend = new LlmBackend({
    base: "https://api.deepseek.com", key: "k", model: "m", lang: "en",
    fetchImpl: fakeFetch({ choices: [{ message: { content: "Answer: **(D)**" } }] }),
  });
  const v = await backend.judge({ text: "why this schema?", context: null });
  const names = Object.keys((await import("../src/definitions.ts")).intents("en"));
  assert.equal(v.intent, names[3]);
});

test("llm judge is not fooled by a stray article in hedged prose", async () => {
  // 同样是 Python 侧实测：取第一个孤立单字母会把 "a" 当成答案 A
  const backend = new LlmBackend({
    base: "https://api.deepseek.com", key: "k", model: "m", lang: "en",
    fetchImpl: fakeFetch({
      choices: [{ message: { content: "As a starting point, I would say (D) is correct." } }],
    }),
  });
  const v = await backend.judge({ text: "why this schema?", context: null });
  const names = Object.keys((await import("../src/definitions.ts")).intents("en"));
  assert.equal(v.intent, names[3]);
});

test("llm judge treats prose with no letter at all as a miss", async () => {
  const backend = new LlmBackend({
    base: "https://api.deepseek.com", key: "k", model: "m", lang: "en",
    fetchImpl: fakeFetch({ choices: [{ message: { content: "it is a task" } }] }),
  });
  const v = await backend.judge({ text: "do this today", context: null });
  const defs = await import("../src/definitions.ts");
  assert.equal(v.intent, defs.fallbackIntent("en"));
  assert.equal(v.confidence, null);
});

test("the llm backend never reports a confidence, not even when the letter parsed", async () => {
  // 解析出字母只说明回答有格式，不说明模型多有把握。1.0 是没人算过的数。
  const backend = new LlmBackend({
    base: "https://api.deepseek.com", key: "k", model: "m", lang: "en",
    fetchImpl: fakeFetch({ choices: [{ message: { content: "(B)" } }] }),
  });
  const v = await backend.judge({ text: "any update?", context: null });
  assert.equal(v.confidence, null);
  assert.equal(v.risk, 0);
});

test("a non-numeric confidence from the gateway becomes null, never NaN", async () => {
  // `Number("high")` 是 NaN——既不是置信度也不是「没有置信度」，还会一路渗进面板。
  const backend = new JevBackend({
    base: "https://api.typesafe.ai", key: "k", model: "m", lang: "zh",
    fetchImpl: fakeFetch({
      answers: {
        intent: { choice: "\u50ac\u8fdb\u5ea6", confidence: "high" },
        risk: { score: 4.2 },
      },
    }),
  });
  const v = await backend.judge({ text: "any update?", context: null });
  assert.equal(v.confidence, null);
  assert.ok(!Number.isNaN(v.confidence as unknown as number));
  assert.equal(v.risk, 4.2);
});

test("llm backend cannot rank and says so rather than inventing numbers", async () => {
  const backend = new LlmBackend({
    base: "https://api.deepseek.com", key: "k", model: "m", lang: "en",
    fetchImpl: fakeFetch({}),
  });
  assert.equal(backend.canRank, false);
  await assert.rejects(() => backend.rank({ text: "m", intent: "chat", candidates: ["a"] }));
});

test("a non-200 response becomes an error, not a silent empty verdict", async () => {
  const backend = new JevBackend({
    base: "https://api.typesafe.ai", key: "k", model: "m", lang: "en",
    fetchImpl: async () => new Response("nope", { status: 401 }),
  });
  await assert.rejects(() => backend.judge({ text: "hi", context: null }), /401/);
});
