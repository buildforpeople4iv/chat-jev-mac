# 网页端聊天适配 · 第 1–2 期实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 先测清英文判断效果、探清五个聊天网站的 DOM 与填入手段，再搭起一个能「读 DOM → 云端判断 → 侧边栏出结果」的 Chrome 扩展骨架。

**Architecture:** 扩展（TypeScript / MV3）负责读页面、调度、显示；判断与生成通过统一的三动作接口打给云端（Jev 或 OpenAI 兼容）；意图、风险、行动建议、话术集中在 `shared/definitions.json`，Python 与 TypeScript 双端读取，用对拍测试防漂移。现有 Python 代码本期只新增，不改动。

**Tech Stack:** Python 3.12 + uv + unittest（现有）；Node 22 + npm + TypeScript + esbuild + node:test + jsdom（新增，仅在 `extension/` 内）。

**Spec:** `docs/superpowers/specs/2026-09-23-web-chat-adapter-design.md`

## Global Constraints

这些是整个计划每个任务都隐含要满足的约束，值照抄自设计文档与 `AGENTS.md`：

- **中文判断层一个字都不能改**：`src/judge.py` 的 `INTENTS`、`RISK_LEVELS`、`ACTION_MAP` 措辞维持原样。英文用另一套并列的定义。
- **中文回归不能退**：`uv run python src/judge_zh_test.py` 的 22 条口径 86.4% 是底线。
- **Python 测试用 unittest**，不是 pytest：`uv run python -B -m unittest discover -s tests`。
- **填入三原则**（本期不实现填入，但探测要按此判定手段可用）：不自动发送、不覆盖已有草稿、不使用系统剪贴板。
- **方向不确定即弃用**：`isSelf` 为 `null` 的消息不作为回复目标。
- **扩展权限按站点申请**，`manifest.json` 里不要 `<all_urls>`，用 `optional_host_permissions`。
- **只读 DOM**，不调用任何聊天平台的官方接口，不自动发送。
- **日志与报告不含消息正文**：沿用现有原则，探测产物中的聊天内容一律脱敏。
- **`results/` 已在 .gitignore**：跑分原始结果落在那里不提交，结论数字写进 `docs/` 里的报告。

---

### Task 1: 英文意图回归集与三后端跑分脚本

**Files:**
- Create: `src/judge_en_test.py`
- Test: `tests/test_judge_en.py`

**Interfaces:**
- Consumes: 无（本任务是全新文件，不 import `judge.py` 的中文定义）
- Produces: `INTENTS_EN: dict[str, str]`、`RISK_LEVELS_EN: list[str]`、`CASES: list[tuple[str, str]]`、
  `parse_letter_answer(text: str, n_options: int) -> int | None`、`summarize(run: dict) -> dict`

- [ ] **Step 1: 写失败的测试**

创建 `tests/test_judge_en.py`：

```python
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

import judge_en_test as en


# 全部离线：只测数据集完整性与纯函数，不加载模型、不发网络请求。
class DatasetTests(unittest.TestCase):
    def test_every_gold_label_is_a_known_intent(self):
        for text, gold in en.CASES:
            with self.subTest(text=text):
                self.assertIn(gold, en.INTENTS_EN)

    def test_four_cases_per_intent(self):
        counts = {name: 0 for name in en.INTENTS_EN}
        for _text, gold in en.CASES:
            counts[gold] += 1
        self.assertEqual(set(counts.values()), {4}, counts)

    def test_no_duplicate_messages(self):
        texts = [t for t, _g in en.CASES]
        self.assertEqual(len(texts), len(set(texts)))

    def test_risk_scale_has_ten_levels(self):
        # 与中文侧同构：judge.py 的 RISK_LEVELS 是 0..9 十档
        self.assertEqual(len(en.RISK_LEVELS_EN), 10)


class LetterAnswerTests(unittest.TestCase):
    def test_plain_letter(self):
        self.assertEqual(en.parse_letter_answer('B', 8), 1)

    def test_parenthesized(self):
        self.assertEqual(en.parse_letter_answer('(C)', 8), 2)

    def test_with_prefix_and_markup(self):
        self.assertEqual(en.parse_letter_answer('Answer: **(D)**', 8), 3)

    def test_lowercase(self):
        self.assertEqual(en.parse_letter_answer('answer: e', 8), 4)

    def test_out_of_range_is_none(self):
        self.assertIsNone(en.parse_letter_answer('J', 8))

    def test_no_letter_is_none(self):
        self.assertIsNone(en.parse_letter_answer('I think it is a task', 8))


class SummarizeTests(unittest.TestCase):
    def test_accuracy_and_per_intent(self):
        run = {'model': 'fake', 'elapsed_s': 1.0, 'results': [
            {'text': 'a', 'gold': 'assign', 'pred': 'assign', 'conf': 0.9},
            {'text': 'b', 'gold': 'assign', 'pred': 'chase', 'conf': 0.4},
            {'text': 'c', 'gold': 'praise', 'pred': 'praise', 'conf': 0.8},
        ]}
        s = en.summarize(run)
        self.assertAlmostEqual(s['acc'], 2 / 3)
        self.assertEqual(s['n'], 3)
        self.assertEqual(s['per_intent']['assign'], 0.5)
        self.assertEqual(s['per_intent']['praise'], 1.0)
        self.assertAlmostEqual(s['majority_baseline'], 0.667, places=3)
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `uv run python -B -m unittest discover -s tests -v -k judge_en`
Expected: FAIL，`ModuleNotFoundError: No module named 'judge_en_test'`

- [ ] **Step 3: 写数据集与纯函数**

创建 `src/judge_en_test.py`，先写到 `summarize` 为止（跑分函数下一步再加）：

```python
"""English intent regression: does the judging layer hold up outside Chinese?

Mirrors src/judge_zh_test.py in shape. One dataset, three backends:
  * decider-2b with an English option list (local, same letter-logit readout)
  * TypeSafe Jev with English criteria (cloud)
  * a generic OpenAI-compatible chat model asked for a single letter (cloud)

src/judge.py is NOT imported here on purpose: its Chinese wording is measured by
judge_zh_test.py at 86.4% and must not move. This file carries its own English text.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

import numpy as np

# Same eight intents as the Chinese side, written natively rather than translated —
# a translated option list is a different prompt and would measure the translation.
INTENTS_EN: dict[str, str] = {
    "assign": "they are handing me a task or asking me to do something",
    "chase": "they are pushing me to finish something already underway",
    "status": "they are asking where something stands",
    "criticize": "they are unhappy with my work or pointing out a mistake",
    "explain": "they want my reasoning or an explanation",
    "chat": "they are just chatting or sharing, with no request",
    "meeting": "they want to set up a meeting or a call",
    "praise": "they are complimenting my work",
}

RISK_LEVELS_EN: list[str] = [
    "no risk at all, any reply works",
    "basically no risk",
    "routine, a normal reply is fine",
    "worth a little care",
    "slightly sensitive, watch the wording",
    "needs caution, could be picked apart",
    "risky, easy to offend or step wrong",
    "very risky, a wrong word causes trouble",
    "highly risky, responsibility or money is involved",
    "extremely risky, do not reply yet, think first",
]

# (message, gold intent) — half Slack-flavoured work talk, half WhatsApp-flavoured DMs
CASES: list[tuple[str, str]] = [
    ("Can you take a look at the onboarding doc today?", "assign"),
    ("Please push the fix to staging before EOD.", "assign"),
    ("Need you to own the migration checklist.", "assign"),
    ("Hey, could you draft the release notes for v2?", "assign"),
    ("Any update on that ticket? It's been two days.", "chase"),
    ("Still waiting on the deploy here.", "chase"),
    ("Is the fix going out today or not?", "chase"),
    ("Bumping this, we need it before the demo.", "chase"),
    ("Where are we on the billing page?", "status"),
    ("Did the migration finish?", "status"),
    ("How's the client feedback looking?", "status"),
    ("What's the current state of the API work?", "status"),
    ("This query is wrong, look at it again.", "criticize"),
    ("Why is prod broken again?", "criticize"),
    ("This isn't what we agreed on at all.", "criticize"),
    ("Honestly the copy here reads terrible.", "criticize"),
    ("Why did you pick Postgres over Dynamo?", "explain"),
    ("Walk me through your reasoning here.", "explain"),
    ("Where did this number come from?", "explain"),
    ("What made you change the schema?", "explain"),
    ("lol that meme killed me", "chat"),
    ("Went hiking this weekend, weather was unreal.", "chat"),
    ("Coffee machine is broken again, pray for us.", "chat"),
    ("Can't believe it's already Friday.", "chat"),
    ("Got 15 min this afternoon to sync?", "meeting"),
    ("Let's hop on a quick call.", "meeting"),
    ("Can we book something for Tuesday morning?", "meeting"),
    ("Standup moved to 10, joining?", "meeting"),
    ("This turned out great, nice work.", "praise"),
    ("Ship it, clean solution.", "praise"),
    ("You crushed that demo.", "praise"),
    ("Really solid write-up, thanks for that.", "praise"),
]

LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

_LETTER_RE = re.compile(r"[（(\[]?\s*([A-Za-z])\s*[)）\]]?")


def parse_letter_answer(text: str, n_options: int) -> int | None:
    """Index of the option a free-text answer picked, or None when it picked nothing.

    Chat models answer "B", "(B)", "Answer: **(B)**" and every mix of those. Anything
    without a letter in range is a miss, not a guess — a silently wrong index would
    show up as a model accuracy problem rather than a parsing problem.
    """
    stripped = re.sub(r"[*_#`]", "", text or "").strip()
    m = _LETTER_RE.search(stripped)
    if not m:
        return None
    idx = LETTERS.find(m.group(1).upper())
    return idx if 0 <= idx < n_options else None


def option_block(names: list[str]) -> str:
    return "".join(f"({LETTERS[i]}) {n} - {INTENTS_EN[n]}\n" for i, n in enumerate(names))


def summarize(run: dict) -> dict:
    res = run["results"]
    n = len(res)
    correct = sum(1 for r in res if r["pred"] == r["gold"])
    by_gold: dict[str, list[bool]] = {}
    for r in res:
        by_gold.setdefault(r["gold"], []).append(r["pred"] == r["gold"])
    return {
        "model": run["model"],
        "acc": correct / n,
        "n": n,
        "elapsed_s": round(run["elapsed_s"], 1),
        "per_intent": {k: round(sum(v) / len(v), 2) for k, v in by_gold.items()},
        "majority_baseline": round(max(
            sum(1 for r in res if r["gold"] == g) for g in {r["gold"] for r in res}) / n, 3),
    }
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `uv run python -B -m unittest discover -s tests -v -k judge_en`
Expected: PASS，11 个测试全绿

- [ ] **Step 5: 提交**

```bash
git add src/judge_en_test.py tests/test_judge_en.py
git commit -m "test: 英文意图回归集（32 条）与离线纯函数"
```

- [ ] **Step 6: 加三个后端的跑分函数**

追加到 `src/judge_en_test.py`：

```python
def run_decider_en() -> dict:
    """Mapika/decider-2b, English option list, same letter-logit readout as the zh test."""
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    repo = "Mapika/decider-2b"
    tok = AutoTokenizer.from_pretrained(repo)
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    # must match src/judge.py — measuring another dtype measures a config nobody ships
    dtype = torch.float16 if dev == "mps" else torch.float32
    model = AutoModelForCausalLM.from_pretrained(repo, dtype=dtype).to(dev).eval()
    names = list(INTENTS_EN)
    lids = [tok.encode(c, add_special_tokens=False)[0] for c in LETTERS[: len(names)]]
    temp = 1.3

    t0 = time.perf_counter()
    results = []
    for text, gold in CASES:
        prompt = (f"Context:\n{text}\n\nQuestion: What is this message really asking for?\n"
                  f"Options:\n{option_block(names)}Answer: (")
        ids = tok(prompt, return_tensors="pt").to(dev)
        with torch.no_grad():
            logits = model(**ids).logits[0, -1]
        probs = torch.softmax(logits[lids].float() / temp, -1).cpu().numpy()
        results.append({"text": text, "gold": gold, "pred": names[int(np.argmax(probs))],
                        "conf": float(probs.max())})
    return {"model": "decider-2b-en", "elapsed_s": time.perf_counter() - t0,
            "results": results}


def run_jev_en() -> dict:
    """TypeSafe Jev with English criteria — same payload shape as src/judge_jev.py."""
    import judge_jev

    j = judge_jev.JevJudge()
    if not j.key:
        raise RuntimeError("TYPESAFE_API_KEY not configured")
    names = list(INTENTS_EN)

    t0 = time.perf_counter()
    results = []
    for text, gold in CASES:
        payload = {
            "model": j.model,
            "state": text,
            "questions": {
                "intent": {"type": "choice",
                           "instructions": "What is this message really asking for?",
                           "criteria": INTENTS_EN},
            },
        }
        try:
            ans = (j._post(payload).get("answers") or {}).get("intent") or {}
            pred = ans.get("choice")
            pred = pred if pred in names else f"ERR:unmapped({pred})"
            conf = float(ans.get("confidence") or 0.0)
        except Exception as e:
            pred, conf = f"ERR:{type(e).__name__}", 0.0
        results.append({"text": text, "gold": gold, "pred": pred, "conf": conf})
    return {"model": f"jev/{j.model}", "elapsed_s": time.perf_counter() - t0,
            "results": results}


def run_llm_en() -> dict:
    """The fallback backend: a generic chat model asked for exactly one letter."""
    import generate

    g = generate.Generator()
    names = list(INTENTS_EN)
    t0 = time.perf_counter()
    results = []
    for text, gold in CASES:
        prompt = (f"Message: \"{text}\"\n\n"
                  f"What is this message really asking for?\n{option_block(names)}\n"
                  f"Reply with one letter and nothing else.")
        try:
            raw = g._call(prompt)
            idx = parse_letter_answer(raw, len(names))
            pred = names[idx] if idx is not None else f"ERR:unparsed({raw[:20]})"
        except Exception as e:
            pred = f"ERR:{type(e).__name__}"
        results.append({"text": text, "gold": gold, "pred": pred, "conf": 0.0})
    return {"model": f"llm/{g._creds_or_load()[2]}", "elapsed_s": time.perf_counter() - t0,
            "results": results}


def main() -> None:
    out_path = Path("results/judge_en.json")
    out_path.parent.mkdir(exist_ok=True)
    report = {}
    for name, fn in (("decider_en", run_decider_en), ("jev_en", run_jev_en),
                     ("llm_en", run_llm_en)):
        print(f"\n===== {name} =====", flush=True)
        try:
            run = fn()
            s = summarize(run)
            report[name] = {"summary": s, "results": run["results"]}
            print(f"acc={s['acc']:.3f}  n={s['n']}  elapsed={s['elapsed_s']}s  "
                  f"majority_baseline={s['majority_baseline']}")
            print("per-intent:", s["per_intent"])
            for r in run["results"]:
                flag = "OK " if r["pred"] == r["gold"] else "XX "
                print(f"  {flag}{r['text'][:34]:36s} gold={r['gold']:10s} "
                      f"pred={r['pred']}")
        except Exception as e:
            import traceback
            report[name] = {"error": f"{type(e).__name__}: {e}"}
            print("FAILED:", e)
            traceback.print_exc()
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=1))
    print(f"\nsaved {out_path}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 7: 确认离线测试仍然通过，且中文回归未被波及**

Run: `uv run python -B -m unittest discover -s tests -v -k judge_en`
Expected: PASS

Run: `git diff --stat src/judge.py`
Expected: 空输出（中文判断层一个字没动）

- [ ] **Step 8: 提交**

```bash
git add src/judge_en_test.py
git commit -m "test: 英文回归的三个后端跑分（decider-2b / Jev / 通用 LLM）"
```

- [ ] **Step 9: 实跑三个后端，把数字记下来**

Run: `uv run python src/judge_en_test.py`

这一步要联网、要 key、本地后端首次会下载约 7 GB 模型。产出 `results/judge_en.json`（不提交）。
把三个后端的 `acc`、`per_intent`、耗时抄进 Task 4 的报告，不要只留在终端里。

任一后端报 `ERR:` 超过 3 条时，先判断是配置问题还是模型问题（`ERR:unparsed` 是解析、
`ERR:HTTPError` 是网络或 key、`ERR:unmapped` 是网关回了别的标签），修掉再重跑。

---

### Task 2: 扩展工程骨架与工具链

**Files:**
- Create: `extension/package.json`, `extension/tsconfig.json`, `extension/src/version.ts`, `extension/test/toolchain.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: 无
- Produces: npm 脚本 `npm test`、`npm run typecheck`、`npm run build`；测试运行方式 `node --import tsx --test`

- [ ] **Step 1: 建工程文件**

创建 `extension/package.json`：

```json
{
  "name": "chat-jev-extension",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --import tsx --test \"test/**/*.test.ts\"",
    "typecheck": "tsc --noEmit",
    "build": "node scripts/build.mjs"
  },
  "devDependencies": {
    "@types/chrome": "^0.0.268",
    "@types/node": "^22.7.0",
    "esbuild": "^0.24.0",
    "@types/jsdom": "^21.1.0",
    "jsdom": "^25.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  }
}
```

创建 `extension/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "resolveJsonModule": true,
    "types": ["node", "chrome"],
    "noEmit": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.mjs"]
}
```

创建 `extension/src/version.ts`：

```ts
export const EXTENSION_VERSION = "0.0.0";
```

创建 `extension/test/toolchain.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { EXTENSION_VERSION } from "../src/version.ts";

test("typescript sources load under the test runner", () => {
  assert.equal(EXTENSION_VERSION, "0.0.0");
});

test("jsdom parses html so adapter tests can run offline", () => {
  const dom = new JSDOM(`<div role="log"><p>hello</p></div>`);
  const log = dom.window.document.querySelector('[role="log"]');
  assert.equal(log?.textContent, "hello");
});
```

- [ ] **Step 2: 装依赖并跑测试，确认工具链通**

Run: `cd extension && npm install && npm test`
Expected: PASS，2 个测试通过

若 `node --import tsx` 报错，检查 Node 版本：`node --version` 需要 ≥ 20。本机实测为 v22.18.0。

- [ ] **Step 3: 忽略构建产物**

在 `.gitignore` 末尾追加：

```
# Chrome 扩展
extension/node_modules/
extension/dist/
extension/src/generated/
```

- [ ] **Step 4: 确认 typecheck 通过**

Run: `cd extension && npm run typecheck`
Expected: 无输出（tsc 无错误）

`npm run build` 此时会失败，因为 `scripts/build.mjs` 还不存在——它在 Task 10 建。
本步不要为了让它通过而造一个空脚本。

- [ ] **Step 5: 提交**

```bash
git add extension/package.json extension/tsconfig.json extension/src/version.ts \
        extension/test/toolchain.test.ts extension/package-lock.json .gitignore
git commit -m "chore: 扩展工程骨架（TypeScript + node:test + jsdom）"
```

---

### Task 3: DOM 探测采集器

> 实施后记：下面的参考代码有两个 bug，已在实现中修正，以仓库代码为准。
> `describeElement` 不能用 `textContent`（相邻行内元素会无分隔符拼接）；
> `anonymize` 只洗文本节点不够——属性值、HTML 注释、以及 `<template>` 的
> `.content` 片段都会把真实聊天内容原样带进快照。

**Files:**
- Create: `extension/src/probe/collect.ts`, `extension/scripts/build-probe.mjs`, `extension/test/probe.collect.test.ts`
- Modify: `extension/package.json`（加一个 npm 脚本）

**Interfaces:**
- Consumes: Task 2 的工具链
- Produces: `findMessageContainers(doc: Document): ContainerReport[]`、
  `describeElement(el: Element): ElementShape`、`anonymize(root: Element): string`

- [ ] **Step 1: 写失败的测试**

创建 `extension/test/probe.collect.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { findMessageContainers, describeElement, anonymize } from "../src/probe/collect.ts";

const CHAT = `
<main>
  <div role="log" class="msg-list">
    <div class="row in"><span class="who">Ana</span><span class="body">hey are you around</span></div>
    <div class="row in"><span class="who">Ana</span><span class="body">need the doc today</span></div>
    <div class="row out"><span class="body">on it</span></div>
  </div>
  <div class="composer"><div contenteditable="true"></div></div>
</main>`;

test("ranks the repeated-children container above its wrappers", () => {
  const doc = new JSDOM(CHAT).window.document;
  const found = findMessageContainers(doc);
  assert.ok(found.length > 0);
  assert.equal(found[0]!.selector, '[role="log"]');
  assert.equal(found[0]!.childCount, 3);
});

test("reports the signals an adapter will need", () => {
  const doc = new JSDOM(CHAT).window.document;
  const row = doc.querySelector(".row.in")!;
  const shape = describeElement(row);
  assert.deepEqual(shape.classes, ["row", "in"]);
  assert.equal(shape.tag, "div");
  assert.equal(shape.text, "Ana hey are you around");
});

test("anonymize replaces text but keeps structure and attributes", () => {
  const doc = new JSDOM(CHAT).window.document;
  const html = anonymize(doc.querySelector('[role="log"]')!);
  assert.ok(html.includes('class="row in"'), "结构属性必须保留");
  assert.ok(!html.includes("need the doc today"), "正文必须脱敏");
  assert.ok(/[a-z]{3,}/.test(html), "脱敏后仍要有占位文字，长度可比对");
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cd extension && npm test`
Expected: FAIL，`Cannot find module '../src/probe/collect.ts'`

- [ ] **Step 3: 实现采集器**

创建 `extension/src/probe/collect.ts`：

```ts
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
  selector: string;
  childCount: number;
  childShapes: ElementShape[];
}

const STRUCTURAL_ATTRS = /^(role|aria-|data-)/;

export function describeElement(el: Element): ElementShape {
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) {
    if (STRUCTURAL_ATTRS.test(a.name)) attrs[a.name] = a.value;
  }
  return {
    tag: el.tagName.toLowerCase(),
    classes: Array.from(el.classList),
    attrs,
    text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
  };
}

function selectorFor(el: Element): string {
  const role = el.getAttribute("role");
  if (role) return `[role="${role}"]`;
  const testid = el.getAttribute("data-testid") ?? el.getAttribute("data-qa");
  if (testid) return `[data-testid="${testid}"]`;
  if (el.id) return `#${el.id}`;
  const cls = Array.from(el.classList)[0];
  return cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase();
}

/**
 * Candidate message lists, best first. The signal is repetition: a message list is
 * the element with the most same-shaped children carrying text. Wrappers score lower
 * because their children differ from one another.
 */
export function findMessageContainers(doc: Document): ContainerReport[] {
  const reports: ContainerReport[] = [];
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    const kids = Array.from(el.children);
    if (kids.length < 2) continue;
    const withText = kids.filter((k) => (k.textContent ?? "").trim().length > 0);
    if (withText.length < 2) continue;
    const shapes = withText.map(describeElement);
    const signatures = new Set(shapes.map((s) => `${s.tag}.${s.classes[0] ?? ""}`));
    // every row looking alike is the tell; a wrapper's children look different
    if (signatures.size > Math.max(2, withText.length / 2)) continue;
    reports.push({
      selector: selectorFor(el),
      childCount: withText.length,
      childShapes: shapes.slice(0, 5),
    });
  }
  reports.sort((a, b) => b.childCount - a.childCount);
  return reports;
}

/**
 * Structure-preserving anonymization: every text node becomes filler of the same
 * length. Selectors, classes and layout survive; the conversation does not.
 */
export function anonymize(root: Element): string {
  const clone = root.cloneNode(true) as Element;
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const raw = child.nodeValue ?? "";
        child.nodeValue = raw.replace(/\S/g, "x");
      } else {
        walk(child);
      }
    }
  };
  walk(clone);
  return clone.outerHTML;
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `cd extension && npm test`
Expected: PASS，5 个测试通过（含 Task 2 的 2 个）

- [ ] **Step 5: 打包成可粘贴进控制台的一段脚本**

创建 `extension/scripts/build-probe.mjs`：

```js
import { build } from "esbuild";

await build({
  entryPoints: ["src/probe/entry.ts"],
  bundle: true,
  format: "iife",
  target: "chrome120",
  outfile: "dist/probe-collect.js",
});
console.log("built dist/probe-collect.js — 粘贴进目标站点的 DevTools 控制台");
```

创建 `extension/src/probe/entry.ts`：

```ts
import { findMessageContainers, anonymize } from "./collect.ts";

declare global {
  interface Window {
    __jevProbe?: unknown;
  }
}

const containers = findMessageContainers(document);
const best = containers[0];
const bestEl = best ? document.querySelector(best.selector) : null;

const report = {
  url: location.origin + location.pathname,
  probedAt: new Date().toISOString().slice(0, 10),
  containers: containers.slice(0, 5),
  editables: Array.from(document.querySelectorAll('[contenteditable="true"], textarea'))
    .slice(0, 5)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      classes: Array.from(el.classList),
      role: el.getAttribute("role"),
      testid: el.getAttribute("data-testid") ?? el.getAttribute("data-qa"),
    })),
  snapshot: bestEl ? anonymize(bestEl) : null,
};

window.__jevProbe = report;
console.log("[jev-probe] 结果已放在 window.__jevProbe，用 copy(window.__jevProbe) 复制");
```

在 `extension/package.json` 的 `scripts` 里加一行：

```json
    "build:probe": "node scripts/build-probe.mjs",
```

- [ ] **Step 6: 构建探测脚本，确认产物存在**

Run: `cd extension && npm run build:probe && ls -l dist/probe-collect.js`
Expected: 文件存在，大小非零

- [ ] **Step 7: 提交**

```bash
git add extension/src/probe extension/scripts/build-probe.mjs \
        extension/test/probe.collect.test.ts extension/package.json
git commit -m "feat(probe): DOM 探测采集器与控制台脚本"
```

---

### Task 4: 五站现场探测与报告

**Files:**
- Create: `probe/web/<site>/snapshot.html`（五份）、`probe/web/<site>/expected.json`（五份）、
  `docs/superpowers/probes/2026-09-23-web-chat-probe.md`

**Interfaces:**
- Consumes: Task 3 的 `dist/probe-collect.js`、Task 1 的 `results/judge_en.json`
- Produces: 每站的 `snapshot.html`（脱敏 HTML）与 `expected.json`（人工标注的期望解析结果），
  格式见下；以及探测报告中的「首站选定」结论，Task 8 依赖它

**这是人工任务**：需要在真实浏览器里登录各站点，不能由无人值守的 agent 完成。

- [ ] **Step 1: 每个站点跑一遍采集器**

站点：WhatsApp Web、Telegram Web、Slack、Discord、Teams。对每一个：

1. 打开一个**至少有 3 条对方消息和 1 条自己消息**的会话，群聊优先（群聊才有发送者名）。
2. 打开 DevTools 控制台，粘贴 `extension/dist/probe-collect.js` 的内容，回车。
3. 执行 `copy(window.__jevProbe)`，把 JSON 贴进**仓库之外**的临时文件（例如 `~/Desktop`）。
   ⚠️ 这份 JSON 里 `containers[].childShapes[].text` 是**未脱敏的真实聊天内容**——它存在是为了让你
   核对哪条消息对应快照里的哪一行。整份 JSON 绝不能进仓库，只有 `snapshot` 字段脱敏过。
4. 把 JSON 里的 `snapshot` 字段存成 `probe/web/<site>/snapshot.html`。
5. **人工确认脱敏干净**：打开这个 HTML 搜索几个真实词，确认都变成了 `x`。带人名的
   `aria-label`、`title`、`alt` 属性采集器不会处理，手工改掉。

- [ ] **Step 2: 人工标注期望结果**

对每个站点写 `probe/web/<site>/expected.json`。字段与设计文档第 4 节的会话快照一致：

```json
{
  "source": "telegram",
  "isGroup": true,
  "messages": [
    {"text": "xxx xxx xxx", "sender": "xxx", "isSelf": false},
    {"text": "xxx xxx", "sender": "xxx", "isSelf": false},
    {"text": "xx", "isSelf": true}
  ]
}
```

`text` 写脱敏后的样子（和 snapshot.html 里一致），`isSelf` 按你在页面上看到的真实方向标。
这份文件是 Task 8 适配器测试的判据，标错了测试就在保护一个错误。

- [ ] **Step 3: 试填入手段**

每站在控制台里依次试三种写法，记录哪种能让编辑器真正接受文字（输入框显示、切走再回来不消失、
按回车能发出去——**试的时候发给自己或测试群，不要发给真人**）：

```js
// 手段 A：execCommand（老办法，多数富文本编辑器认）
el.focus(); document.execCommand("insertText", false, "test");

// 手段 B：beforeinput + input 事件
el.focus();
el.dispatchEvent(new InputEvent("beforeinput", {inputType: "insertText", data: "test", bubbles: true, cancelable: true}));

// 手段 C：模拟 paste（不碰系统剪贴板，DataTransfer 是临时对象）
const dt = new DataTransfer(); dt.setData("text/plain", "test");
el.dispatchEvent(new ClipboardEvent("paste", {clipboardData: dt, bubbles: true, cancelable: true}));
```

三种都不行的站点记为「填入待解」，不要在报告里含糊带过。

- [ ] **Step 4: 写报告**

创建 `docs/superpowers/probes/2026-09-23-web-chat-probe.md`，必须包含五节：

1. **英文判断结果**：Task 1 三个后端的 `acc`、`per_intent`、耗时，以及结论——默认后端选谁，
   8 类意图要不要调整。
2. **各站消息容器**：选择器、单条消息的 text / sender / ts / id 取法、探测日期。
3. **各站方向信号**：设计文档第 6 节三级阶梯里，这个站点实际能用到第几级。
4. **填入手段矩阵**：五站 × 三种手段，能用打勾，附一句现象描述。
5. **首站选定**：哪个站点进 Task 8，一句话理由（DOM 最清楚且填入手段确定可用）。

- [ ] **Step 5: 提交**

```bash
git add probe/web docs/superpowers/probes/2026-09-23-web-chat-probe.md
git commit -m "docs(probe): 五站 DOM 与填入手段探测报告，英文判断实测结论"
```

注意 `.gitignore` 第 19 行忽略全部 `*.png` 且只放行 `docs/**`。探测截图如果要留，放 `docs/` 下。

---

### Task 5: 共享定义与双端对拍

**Files:**
- Create: `shared/definitions.json`, `src/definitions.py`, `tests/test_definitions_parity.py`,
  `extension/src/definitions.ts`, `extension/scripts/sync-definitions.mjs`,
  `extension/test/definitions.test.ts`
- Modify: `extension/package.json`（加 `pretest` / `prebuild` 钩子）

**Interfaces:**
- Consumes: 无（zh 部分的内容来自现有 `judge.py` 与 `styles.py`，逐字复制）
- Produces: Python 侧 `definitions.load()`、`definitions.intents(lang)`、`definitions.risk_levels(lang)`、
  `definitions.actions(lang)`、`definitions.tones(lang)`；
  TS 侧 `INTENTS`、`RISK_LEVELS`、`ACTIONS`、`TONES`（均按 `lang` 取）

- [ ] **Step 1: 写失败的对拍测试（Python 侧）**

创建 `tests/test_definitions_parity.py`：

```python
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

import definitions
import judge
import styles


# shared/definitions.json 的中文部分必须与线上代码逐字一致。判断层的措辞实测极敏感
# （两轮压缩掉到 81.8% / 77.3%），共享文件抄错一个字就是一次静默回归。
class ChineseParityTests(unittest.TestCase):
    def test_intents_match_judge(self):
        self.assertEqual(definitions.intents('zh'), judge.INTENTS)

    def test_risk_levels_match_judge(self):
        self.assertEqual(definitions.risk_levels('zh'), judge.RISK_LEVELS)

    def test_actions_match_judge(self):
        self.assertEqual(definitions.actions('zh'), judge.ACTION_MAP)

    def test_tones_match_styles(self):
        self.assertEqual(definitions.tones('zh'), styles.BUILTIN)


class EnglishShapeTests(unittest.TestCase):
    def test_same_intent_count_in_both_languages(self):
        # 键不要求相同：zh 的键是中文标签（judge.py 的既有形状），en 的键是英文标签，
        # 两边都直接作为界面文字显示。要求相同的是「有几类」。
        self.assertEqual(len(definitions.intents('en')), len(definitions.intents('zh')))

    def test_fallback_intent_exists_in_both(self):
        for lang in ('zh', 'en'):
            with self.subTest(lang=lang):
                self.assertIn(definitions.fallback_intent(lang), definitions.intents(lang))

    def test_risk_scale_is_ten_levels_in_both(self):
        self.assertEqual(len(definitions.risk_levels('en')), 10)
        self.assertEqual(len(definitions.risk_levels('zh')), 10)

    def test_every_intent_has_actions_in_both(self):
        for lang in ('zh', 'en'):
            with self.subTest(lang=lang):
                self.assertEqual(set(definitions.actions(lang)),
                                 set(definitions.intents(lang)))

    def test_english_tones_exist_for_the_skeleton(self):
        # 完整 10 条英文话术是第 7 期的内容；骨架期先有 3 条可用的
        self.assertGreaterEqual(len(definitions.tones('en')), 3)

    def test_unknown_language_raises(self):
        with self.assertRaises(KeyError):
            definitions.intents('fr')
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `uv run python -B -m unittest discover -s tests -v -k definitions`
Expected: FAIL，`ModuleNotFoundError: No module named 'definitions'`

- [ ] **Step 3: 生成 shared/definitions.json**

中文部分必须逐字来自现有代码，手抄容易出错，用脚本导出一次：

```bash
cd /path/to/repo && uv run python - <<'PY'
import json, sys
sys.path.insert(0, 'src')
import judge, styles
from pathlib import Path

# 英文侧用英文键：键本身就是面板上显示的意图名，与 src/judge_en_test.py 的
# INTENTS_EN 保持一致（顺序也一致，backends 的字母序号依赖它）。
en_intents = {
    "assign": "they are handing me a task or asking me to do something",
    "chase": "they are pushing me to finish something already underway",
    "status": "they are asking where something stands",
    "criticize": "they are unhappy with my work or pointing out a mistake",
    "explain": "they want my reasoning or an explanation",
    "chat": "they are just chatting or sharing, with no request",
    "meeting": "they want to set up a meeting or a call",
    "praise": "they are complimenting my work",
}
en_risk = [
    "no risk at all, any reply works",
    "basically no risk",
    "routine, a normal reply is fine",
    "worth a little care",
    "slightly sensitive, watch the wording",
    "needs caution, could be picked apart",
    "risky, easy to offend or step wrong",
    "very risky, a wrong word causes trouble",
    "highly risky, responsibility or money is involved",
    "extremely risky, do not reply yet, think first",
]
en_actions = {
    "assign": ["take it", "pin down scope and deadline", "give a time first"],
    "chase": ["state where it stands", "commit to a time", "skip the explaining"],
    "status": ["give the facts", "name the next milestone", "say what is blocked"],
    "criticize": ["own it first", "do not argue yet", "offer the fix"],
    "explain": ["give the reason", "no excuses", "say what changes next"],
    "chat": ["keep it light", "engage a little", "no need to overthink"],
    "meeting": ["confirm the time", "set the agenda", "come prepared"],
    "praise": ["accept it and thank them", "skip false modesty", "mention what is next"],
}
en_tones = {
    "Straight answer": (
        "A senior engineer who does not pad: no preamble, no apology, just the "
        "conclusion and a time. Short sentences, subject is the work not the feelings. "
        "Never hedge with 'I'll try' or 'maybe'."
    ),
    "Warm professional": (
        "The colleague everyone likes: acknowledge them first ('makes sense', 'got it'), "
        "then the fact and the next step. A refusal always carries an alternative and a "
        "concrete time. No lecturing, no filler."
    ),
    "Hold the line": (
        "Calm but final: say plainly that it will not happen today and leave no opening "
        "to be pushed. Give one concrete alternative time. At most one sentence of "
        "apology and one of reason."
    ),
}

data = {
    "note": "Single source of truth for intents, risk, actions and tones. "
            "Python reads it via src/definitions.py, the extension via "
            "extension/src/definitions.ts. The zh half must stay byte-identical to "
            "src/judge.py and src/styles.py — tests/test_definitions_parity.py enforces it.",
    "intents": {"zh": judge.INTENTS, "en": en_intents},
    "risk_levels": {"zh": judge.RISK_LEVELS, "en": en_risk},
    "actions": {"zh": judge.ACTION_MAP, "en": en_actions},
    "tones": {"zh": styles.BUILTIN, "en": en_tones},
    # 网关回了认不出的标签时退到哪一类。judge_jev.py 里中文侧硬编码为「闲聊」，
    # 英文侧不能照抄这个字符串，所以做成按语言取。
    "fallback_intent": {"zh": "闲聊", "en": "chat"},
}
Path('shared').mkdir(exist_ok=True)
Path('shared/definitions.json').write_text(
    json.dumps(data, ensure_ascii=False, indent=2) + "\n")
print("wrote shared/definitions.json")
PY
```

- [ ] **Step 4: 写 Python 读取层**

创建 `src/definitions.py`：

```python
"""Shared definitions loader: intents, risk levels, actions and tones.

One file (shared/definitions.json) feeds both the Python app and the browser
extension. The Chinese half is the wording that src/judge.py and src/styles.py
already ship — tests/test_definitions_parity.py fails the moment the two drift.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

PATH = Path(__file__).resolve().parents[1] / "shared" / "definitions.json"


@lru_cache(maxsize=1)
def load() -> dict:
    return json.loads(PATH.read_text(encoding="utf-8"))


def _section(name: str, lang: str):
    section = load()[name]
    if lang not in section:
        raise KeyError(f"{name}: no such language {lang!r}")
    return section[lang]


def intents(lang: str) -> dict[str, str]:
    return _section("intents", lang)


def risk_levels(lang: str) -> list[str]:
    return _section("risk_levels", lang)


def actions(lang: str) -> dict[str, list[str]]:
    return _section("actions", lang)


def tones(lang: str) -> dict[str, str]:
    return _section("tones", lang)


def fallback_intent(lang: str) -> str:
    return _section("fallback_intent", lang)
```

- [ ] **Step 5: 跑 Python 测试，确认通过**

Run: `uv run python -B -m unittest discover -s tests -v -k definitions`
Expected: PASS，10 个测试通过

失败在 `test_tones_match_styles` 时，多半是 `styles.BUILTIN` 里有 `userconfig` 注入的自定义话术。
检查 `styles.py` 的 `BUILTIN` 是否为纯字面量 dict；若不是，对拍要改成比较内置那部分。

- [ ] **Step 6: 写 TS 侧读取与测试**

创建 `extension/scripts/sync-definitions.mjs`：

```js
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const src = resolve("../shared/definitions.json");
const dst = resolve("src/generated/definitions.json");
mkdirSync(dirname(dst), { recursive: true });
copyFileSync(src, dst);
console.log("synced shared/definitions.json -> src/generated/");
```

在 `extension/package.json` 的 `scripts` 里加两行（放在 `test` 与 `build` 之前执行）：

```json
    "pretest": "node scripts/sync-definitions.mjs",
    "pretypecheck": "node scripts/sync-definitions.mjs",
    "prebuild": "node scripts/sync-definitions.mjs",
```

创建 `extension/src/definitions.ts`：

```ts
import data from "./generated/definitions.json" with { type: "json" };

export type Lang = "zh" | "en";

interface Definitions {
  intents: Record<Lang, Record<string, string>>;
  risk_levels: Record<Lang, string[]>;
  actions: Record<Lang, Record<string, string[]>>;
  tones: Record<Lang, Record<string, string>>;
  fallback_intent: Record<Lang, string>;
}

const defs = data as unknown as Definitions;

export const intents = (lang: Lang) => defs.intents[lang];
export const riskLevels = (lang: Lang) => defs.risk_levels[lang];
export const actions = (lang: Lang) => defs.actions[lang];
export const tones = (lang: Lang) => defs.tones[lang];
export const fallbackIntent = (lang: Lang) => defs.fallback_intent[lang];
```

创建 `extension/test/definitions.test.ts`：

```ts
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
```

- [ ] **Step 7: 跑扩展测试，确认通过**

Run: `cd extension && npm test`
Expected: PASS，10 个测试通过（Task 2 的 2 个 + Task 3 的 3 个 + 本任务 5 个）

- [ ] **Step 8: 提交**

```bash
git add shared/definitions.json src/definitions.py tests/test_definitions_parity.py \
        extension/src/definitions.ts extension/scripts/sync-definitions.mjs \
        extension/test/definitions.test.ts extension/package.json
git commit -m "feat: 共享定义文件与双端读取，中文部分对拍现有实现"
```

---

### Task 6: 会话快照类型与校验

**Files:**
- Create: `extension/src/contracts/snapshot.ts`, `extension/test/snapshot.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `ChatMessage`、`ConversationSnapshot` 类型；
  `messageId(text: string, index: number, sender?: string): string`；
  `validateSnapshot(value: unknown): { ok: true; snapshot: ConversationSnapshot } | { ok: false; error: string }`；
  `newestIncoming(s: ConversationSnapshot): ChatMessage | null`

- [ ] **Step 1: 写失败的测试**

创建 `extension/test/snapshot.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cd extension && npm test`
Expected: FAIL，`Cannot find module '../src/contracts/snapshot.ts'`

- [ ] **Step 3: 实现契约**

创建 `extension/src/contracts/snapshot.ts`：

```ts
/**
 * Contract 1 — the conversation snapshot every message source produces.
 *
 * Site adapters and the macOS WeChat reader both emit this shape; nothing
 * downstream knows where a snapshot came from. See the spec, section 4.
 */

export interface ChatMessage {
  id: string;
  text: string;
  sender?: string;
  /** true = mine, false = theirs, null = direction unconfirmed (never a reply target) */
  isSelf: boolean | null;
  ts: number;
  mentionsMe: boolean;
}

export interface ConversationSnapshot {
  source: string;
  conversationId: string;
  title: string;
  isGroup: boolean;
  messages: ChatMessage[];
  input: { canFill: boolean };
}

/**
 * A stable id for sites that do not give messages one of their own: content plus
 * position. Position matters — the same "ok" sent twice is two messages, and
 * deduplication must not collapse them.
 */
export function messageId(text: string, index: number, sender?: string): string {
  const basis = `${index}\u0000${sender ?? ""}\u0000${text}`;
  let h = 2166136261;
  for (let i = 0; i < basis.length; i++) {
    h ^= basis.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

type Result =
  | { ok: true; snapshot: ConversationSnapshot }
  | { ok: false; error: string };

export function validateSnapshot(value: unknown): Result {
  if (typeof value !== "object" || value === null) return { ok: false, error: "not an object" };
  const v = value as Record<string, unknown>;
  for (const key of ["source", "conversationId", "title"]) {
    if (typeof v[key] !== "string") return { ok: false, error: `${key} must be a string` };
  }
  if (typeof v["isGroup"] !== "boolean") return { ok: false, error: "isGroup must be a boolean" };
  if (!Array.isArray(v["messages"])) return { ok: false, error: "messages must be an array" };
  for (const [i, m] of (v["messages"] as unknown[]).entries()) {
    if (typeof m !== "object" || m === null) return { ok: false, error: `messages[${i}] not an object` };
    const msg = m as Record<string, unknown>;
    if (typeof msg["id"] !== "string") return { ok: false, error: `messages[${i}].id must be a string` };
    if (typeof msg["text"] !== "string") return { ok: false, error: `messages[${i}].text must be a string` };
    if (!(msg["isSelf"] === true || msg["isSelf"] === false || msg["isSelf"] === null)) {
      return { ok: false, error: `messages[${i}].isSelf must be true, false or null` };
    }
  }
  const input = v["input"] as Record<string, unknown> | undefined;
  if (!input || typeof input["canFill"] !== "boolean") {
    return { ok: false, error: "input.canFill must be a boolean" };
  }
  return { ok: true, snapshot: value as ConversationSnapshot };
}

/**
 * The reply target: the last message that is definitely from someone else.
 * `isSelf: null` is deliberately excluded — the spec's conservative rule, inherited
 * from perception.message_side(): better to miss a message than to answer myself.
 */
export function newestIncoming(s: ConversationSnapshot): ChatMessage | null {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i]!;
    if (m.isSelf === false) return m;
  }
  return null;
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `cd extension && npm test && npm run typecheck`
Expected: PASS，17 个测试通过；typecheck 无输出

- [ ] **Step 5: 提交**

```bash
git add extension/src/contracts/snapshot.ts extension/test/snapshot.test.ts
git commit -m "feat(contracts): 会话快照类型、校验与回复目标选取"
```

---

### Task 7: 判断与排序后端客户端

> 实施后记：下面写的动作段 `evaluate` 是**错的**，以仓库实现为准。
> `src/generate.py` 的 `jev_request_url` 规则是：裸主机补 `/v1/systemone`，
> 带版本段补 `/systemone`，而 `evaluate` 只是 Vercel 网关自己的动作名、
> 出现在地址里时原样使用。判定「已是完整动作路径」看的是**倒数第二段是否为版本段**，
> 不是比对最后一段等于某个动作名。权威用例见 tests/test_jev_base_url.py 的九条。

契约二有三个动作，本任务只做 `judge` 与 `rank`。`generate`（候选回复）属于第 3 期
「第一个站点做透」，不在本期骨架内——本期侧边栏只出意图、风险和行动建议。

**Files:**
- Create: `extension/src/backends/types.ts`, `extension/src/backends/url.ts`,
  `extension/src/backends/jev.ts`, `extension/src/backends/llm.ts`,
  `extension/test/backends.url.test.ts`, `extension/test/backends.judge.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `intents` / `riskLevels` / `actions`
- Produces: `Verdict`、`Ranked`、`AnalysisBackend` 接口；
  `jevRequestUrl(base: string): string`；
  `JevBackend`（`judge`、`rank`、`canRank = true`）；
  `LlmBackend`（`judge`、`rank` 抛错、`canRank = false`）；
  两者构造函数均接受 `{ fetchImpl }` 以便离线测试

- [ ] **Step 1: 写失败的 URL 规则测试**

Jev 的地址拼接规则在 Python 侧已有实现与测试（`src/generate.py` 的 `jev_request_url`、
`tests/test_jev_base_url.py`），TS 侧必须给出同样的答案。

创建 `extension/test/backends.url.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { jevRequestUrl } from "../src/backends/url.ts";

test("host only gets the version and action appended", () => {
  assert.equal(jevRequestUrl("https://api.typesafe.ai"), "https://api.typesafe.ai/v1/evaluate");
});

test("trailing slash does not double up", () => {
  assert.equal(jevRequestUrl("https://api.typesafe.ai/"), "https://api.typesafe.ai/v1/evaluate");
});

test("a version segment gets only the action appended", () => {
  assert.equal(jevRequestUrl("https://api.typesafe.ai/v1"), "https://api.typesafe.ai/v1/evaluate");
});

test("a non-v1 version segment is respected", () => {
  assert.equal(jevRequestUrl("https://gw.example.com/api/v4"),
    "https://gw.example.com/api/v4/evaluate");
});

test("a full action path is used verbatim", () => {
  assert.equal(jevRequestUrl("https://ai-gateway.vercel.sh/v1/evaluate"),
    "https://ai-gateway.vercel.sh/v1/evaluate");
});

test("a full action path with trailing slash is normalised, not appended to", () => {
  assert.equal(jevRequestUrl("https://ai-gateway.vercel.sh/v1/evaluate/"),
    "https://ai-gateway.vercel.sh/v1/evaluate");
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cd extension && npm test`
Expected: FAIL，`Cannot find module '../src/backends/url.ts'`

- [ ] **Step 3: 实现 URL 规则**

创建 `extension/src/backends/url.ts`：

```ts
/**
 * Jev endpoint composition — the same three-case rule as src/generate.py's
 * jev_request_url (issue #42). A base that tests fine in the settings window must
 * judge fine here, so the two implementations have to agree case for case.
 */

const ACTION = "evaluate";
const VERSION_SEGMENT = /^v\d+$/;

export function jevRequestUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  const segments = trimmed.split("/").slice(3).filter(Boolean);
  const last = segments[segments.length - 1];
  if (last === ACTION) return trimmed;
  if (last && VERSION_SEGMENT.test(last)) return `${trimmed}/${ACTION}`;
  return `${trimmed}/v1/${ACTION}`;
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `cd extension && npm test`
Expected: PASS，23 个测试通过

- [ ] **Step 5: 写失败的判断后端测试**

创建 `extension/test/backends.judge.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { JevBackend } from "../src/backends/jev.ts";
import { LlmBackend } from "../src/backends/llm.ts";

function fakeFetch(payload: unknown, capture?: (body: unknown) => void) {
  return async (_url: string, init?: RequestInit) => {
    if (capture && init?.body) capture(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(payload), { status: 200 });
  };
}

test("jev judge maps the evaluate response onto a verdict", async () => {
  const backend = new JevBackend({
    base: "https://api.typesafe.ai", key: "k", model: "jev-latest", lang: "en",
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
  assert.equal(v.confidence, 0);
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
```

- [ ] **Step 6: 跑测试，确认失败**

Run: `cd extension && npm test`
Expected: FAIL，`Cannot find module '../src/backends/jev.ts'`

- [ ] **Step 7: 实现两个后端**

创建 `extension/src/backends/types.ts`：

```ts
import type { Lang } from "../definitions.ts";

export interface Verdict {
  intent: string;
  confidence: number;
  intentProbs: Record<string, number>;
  risk: number;
  riskProbs: Record<string, number>;
  actions: string[];
}

export interface Ranked {
  text: string;
  prob: number;
}

export interface JudgeRequest {
  text: string;
  context: string | null;
}

export interface RankRequest {
  text: string;
  intent: string;
  candidates: string[];
}

export interface BackendConfig {
  base: string;
  key: string;
  model: string;
  lang: Lang;
  fetchImpl?: typeof fetch;
}

export interface AnalysisBackend {
  readonly canRank: boolean;
  judge(req: JudgeRequest): Promise<Verdict>;
  rank(req: RankRequest): Promise<Ranked[]>;
}

export async function postJson(
  fetchImpl: typeof fetch, url: string, headers: Record<string, string>, body: unknown,
): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}
```

创建 `extension/src/backends/jev.ts`：

```ts
import { intents, riskLevels, actions, fallbackIntent } from "../definitions.ts";
import { jevRequestUrl } from "./url.ts";
import {
  postJson, type AnalysisBackend, type BackendConfig, type JudgeRequest,
  type RankRequest, type Ranked, type Verdict,
} from "./types.ts";

/** Mirrors src/judge_jev.py: one evaluate call answers intent and risk together. */
export class JevBackend implements AnalysisBackend {
  readonly canRank = true;
  private readonly cfg: BackendConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: BackendConfig) {
    this.cfg = cfg;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private async post(payload: unknown): Promise<Record<string, any>> {
    const url = jevRequestUrl(this.cfg.base);
    const data = await postJson(this.fetchImpl, url,
      { authorization: `Bearer ${this.cfg.key}` }, payload);
    return (data ?? {}) as Record<string, any>;
  }

  async judge(req: JudgeRequest): Promise<Verdict> {
    const lang = this.cfg.lang;
    const table = intents(lang);
    const state = req.context ? `${req.context}\n\n${req.text}` : req.text;
    const data = await this.post({
      model: this.cfg.model,
      state,
      questions: {
        intent: {
          type: "choice",
          instructions: lang === "en"
            ? "What is this message really asking for?"
            : "这句话的真实意图是什么？",
          criteria: table,
        },
        risk: {
          type: "score",
          instructions: lang === "en"
            ? "How risky is it to reply to this directly?"
            : "如果直接回复这句话，风险有多大？",
          criteria: riskLevels(lang),
        },
      },
    });
    const answers = data["answers"] ?? {};
    const intentAns = answers["intent"] ?? {};
    const riskAns = answers["risk"] ?? {};

    const fallback = fallbackIntent(lang);
    let intent: string = intentAns["choice"] ?? fallback;
    if (!(intent in table)) {
      // gateways occasionally echo an index or a near-miss label (same guard as Python),
      // but the fallback must be the current language's label, not a hardcoded 闲聊
      intent = Object.keys(table).find((n) => String(intentAns["choice"] ?? "").includes(n))
        ?? fallback;
    }
    const risk = typeof riskAns["score"] === "number" ? riskAns["score"] : 0;
    return {
      intent,
      confidence: Number(intentAns["confidence"] ?? 0),
      intentProbs: intentAns["probabilities"] ?? {},
      risk: Math.round(risk * 10) / 10,
      riskProbs: riskAns["probabilities"] ?? {},
      actions: actions(lang)[intent] ?? [],
    };
  }

  async rank(req: RankRequest): Promise<Ranked[]> {
    if (req.candidates.length === 0) return [];
    const criteria: Record<string, null> = {};
    for (const c of req.candidates) criteria[c] = null;
    const data = await this.post({
      model: this.cfg.model,
      state: `Message: ${req.text}\nJudged intent: ${req.intent}`,
      questions: {
        best: { type: "choice", instructions: "Which reply fits best?", criteria },
      },
    });
    const ans = (data["answers"] ?? {})["best"] ?? {};
    const probs: Record<string, number> = ans["probabilities"] ?? {};
    return req.candidates
      .map((text) => ({
        text,
        prob: probs[text] ?? (ans["choice"] === text ? Number(ans["confidence"] ?? 0) : 0),
      }))
      .sort((a, b) => b.prob - a.prob);
  }
}
```

创建 `extension/src/backends/llm.ts`：

```ts
import { intents, actions, fallbackIntent } from "../definitions.ts";
import {
  postJson, type AnalysisBackend, type BackendConfig, type JudgeRequest,
  type RankRequest, type Ranked, type Verdict,
} from "./types.ts";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// 括号字母是明确标注的答案，优先于句子里任何孤立单字母
const BRACKETED = /[（(\[]\s*([A-Za-z])\s*[)）\]]/;
// 次选：紧跟在 answer 后面的字母（"answer: e"）
const PREFIXED = /\banswer\b[^A-Za-z0-9]*([A-Za-z])\b/i;

/**
 * Parse "B", "(B)", "Answer: **(B)**" — the TS twin of judge_en_test.parse_letter_answer.
 * Keep the two implementations in step; this three-tier shape exists because a single
 * regex cannot tell a boxed answer from the article "a" sitting earlier in a hedged
 * sentence ("As a starting point, I would say (D) is correct"), and picking the first
 * bare letter got that case wrong in Python before it was fixed there.
 */
export function parseLetter(raw: string, nOptions: number): number | null {
  const stripped = (raw ?? "").replace(/[*_#`]/g, "").trim();
  const m = BRACKETED.exec(stripped) ?? PREFIXED.exec(stripped);
  let letter: string;
  if (m) letter = m[1]!;
  // a bare letter only counts when it IS the whole reply, never as a stray article
  else if (stripped.length === 1 && /[A-Za-z]/.test(stripped)) letter = stripped;
  else return null;
  const idx = LETTERS.indexOf(letter.toUpperCase());
  return idx >= 0 && idx < nOptions ? idx : null;
}

/**
 * Fallback backend for users who only have one OpenAI-compatible key. It answers
 * intent only: risk comes back 0 and ranking is unavailable — the panel must show
 * neither rather than show a number nobody computed (spec, section 8).
 */
export class LlmBackend implements AnalysisBackend {
  readonly canRank = false;
  private readonly cfg: BackendConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: BackendConfig) {
    this.cfg = cfg;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async judge(req: JudgeRequest): Promise<Verdict> {
    const lang = this.cfg.lang;
    const table = intents(lang);
    const names = Object.keys(table);
    const options = names.map((n, i) => `(${LETTERS[i]}) ${n} - ${table[n]}`).join("\n");
    const prompt = [
      req.context ? `Earlier:\n${req.context}\n` : "",
      `Message: "${req.text}"`,
      "",
      "What is this message really asking for?",
      options,
      "",
      "Reply with one letter and nothing else.",
    ].join("\n");

    const base = this.cfg.base.replace(/\/+$/, "");
    const url = /\/v\d+$/.test(base)
      ? `${base}/chat/completions`
      : `${base}/v1/chat/completions`;
    const data = (await postJson(this.fetchImpl, url,
      { authorization: `Bearer ${this.cfg.key}` },
      {
        model: this.cfg.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 8,
        temperature: 0,
      })) as Record<string, any>;

    const raw = data?.choices?.[0]?.message?.content ?? "";
    const idx = parseLetter(String(raw), names.length);
    // an unparseable answer is a miss, not a guess: fall back to the catch-all intent
    // and report confidence 0 so the panel can show it as uncertain
    const intent = idx === null ? fallbackIntent(lang) : names[idx]!;
    return {
      intent,
      confidence: idx === null ? 0 : 1,
      intentProbs: {},
      risk: 0,
      riskProbs: {},
      actions: actions(lang)[intent] ?? [],
    };
  }

  async rank(_req: RankRequest): Promise<Ranked[]> {
    throw new Error("this backend cannot rank; the panel must hide probabilities");
  }
}
```

- [ ] **Step 8: 跑测试与类型检查，确认通过**

Run: `cd extension && npm test && npm run typecheck`
Expected: PASS，33 个测试通过；typecheck 无输出

`llm judge parses a single-letter answer` 这条断言取的是英文意图表的第 2 个键，
键序由 `shared/definitions.json` 决定，与 Task 5 生成的顺序一致。

- [ ] **Step 9: 提交**

```bash
git add extension/src/backends extension/test/backends.url.test.ts \
        extension/test/backends.judge.test.ts
git commit -m "feat(backends): Jev 与通用 LLM 的判断/排序客户端"
```

---

### Task 8: 首站适配器与快照回归

**Files:**
- Create: `extension/src/adapters/types.ts`, `extension/src/adapters/<site>.ts`,
  `extension/src/adapters/registry.ts`, `extension/test/adapters.<site>.test.ts`

`<site>` 是 Task 4 报告第 5 节选定的站点，下面的代码里按实际站名替换。

**Interfaces:**
- Consumes: Task 4 的 `probe/web/<site>/snapshot.html` 与 `expected.json`；Task 6 的
  `ConversationSnapshot`、`messageId`
- Produces: `SiteAdapter` 接口（`id`、`matches(url)`、`readSnapshot(doc)`、`probedAt`）；
  `pickAdapter(url: string): SiteAdapter | null`

- [ ] **Step 1: 写失败的测试**

创建 `extension/test/adapters.<site>.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { adapter } from "../src/adapters/<site>.ts";
import { pickAdapter } from "../src/adapters/registry.ts";
import { validateSnapshot, newestIncoming } from "../src/contracts/snapshot.ts";

const html = readFileSync("../probe/web/<site>/snapshot.html", "utf8");
const expected = JSON.parse(readFileSync("../probe/web/<site>/expected.json", "utf8"));

function parse() {
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  return adapter.readSnapshot(doc);
}

test("the adapter claims its own urls and nothing else", () => {
  assert.equal(pickAdapter(expected.sampleUrl)?.id, adapter.id);
  assert.equal(pickAdapter("https://example.com/chat"), null);
});

test("reads every message out of the probe snapshot", () => {
  const snap = parse();
  assert.equal(snap.messages.length, expected.messages.length);
});

test("message text matches the hand-labelled expectation", () => {
  const snap = parse();
  assert.deepEqual(snap.messages.map((m) => m.text), expected.messages.map((m: any) => m.text));
});

test("direction matches the hand-labelled expectation", () => {
  const snap = parse();
  assert.deepEqual(snap.messages.map((m) => m.isSelf),
    expected.messages.map((m: any) => m.isSelf));
});

test("sender names are read where the expectation has them", () => {
  const snap = parse();
  assert.deepEqual(snap.messages.map((m) => m.sender ?? null),
    expected.messages.map((m: any) => m.sender ?? null));
});

test("the produced snapshot satisfies the contract", () => {
  assert.equal(validateSnapshot(parse()).ok, true);
});

test("the reply target is the last incoming message", () => {
  const snap = parse();
  const lastIncoming = [...expected.messages].reverse().find((m: any) => m.isSelf === false);
  assert.equal(newestIncoming(snap)?.text, lastIncoming.text);
});

test("an empty page reports a layout change instead of an empty conversation", () => {
  const doc = new JSDOM("<body><main></main></body>").window.document;
  assert.throws(() => adapter.readSnapshot(doc), /layout/i);
});
```

在 `probe/web/<site>/expected.json` 里补一个 `sampleUrl` 字段（该站会话页的 URL，去掉任何 id）。

- [ ] **Step 2: 跑测试，确认失败**

Run: `cd extension && npm test`
Expected: FAIL，`Cannot find module '../src/adapters/<site>.ts'`

- [ ] **Step 3: 写适配器接口与注册表**

创建 `extension/src/adapters/types.ts`：

```ts
import type { ConversationSnapshot } from "../contracts/snapshot.ts";

export interface SiteAdapter {
  /** stable id, also the snapshot's `source` */
  id: string;
  /** the day the selectors below were probed on the live site */
  probedAt: string;
  matches(url: string): boolean;
  /**
   * Read the conversation currently on screen.
   * Throws when the page does not look like what was probed — a layout change must
   * surface as an error the panel can show, never as an empty conversation.
   */
  readSnapshot(doc: Document): ConversationSnapshot;
}

export class LayoutChangedError extends Error {
  constructor(what: string) {
    super(`layout changed: ${what}`);
    this.name = "LayoutChangedError";
  }
}
```

创建 `extension/src/adapters/registry.ts`：

```ts
import type { SiteAdapter } from "./types.ts";
import { adapter as siteAdapter } from "./<site>.ts";

export const ADAPTERS: SiteAdapter[] = [siteAdapter];

export function pickAdapter(url: string): SiteAdapter | null {
  return ADAPTERS.find((a) => a.matches(url)) ?? null;
}
```

- [ ] **Step 4: 写站点适配器**

创建 `extension/src/adapters/<site>.ts`。选择器全部抄自 Task 4 报告第 2、3 节，
**不要凭印象写**；`probedAt` 填探测当天的日期。

```ts
import { messageId, type ChatMessage, type ConversationSnapshot } from "../contracts/snapshot.ts";
import { LayoutChangedError, type SiteAdapter } from "./types.ts";

// 选择器来自 docs/superpowers/probes/2026-09-23-web-chat-probe.md 第 2 节。
// 改这些常量前先重跑一次探测采集器，别照着线上页面手改。
const ROOT = "<报告里的消息列表选择器>";
const ROW = "<报告里的单条消息选择器>";
const BODY = "<报告里的正文选择器>";
const SENDER = "<报告里的发送者名选择器>";
const SELF_MARK = "<报告里表示自己发送的 class 或属性选择器>";
const INPUT = "<报告里的输入框选择器>";

function direction(row: Element): boolean | null {
  // 阶梯一：站点自己的标记。报告第 3 节写明这个站点到底能用到第几级；
  // 用不到的级别删掉，不要留着当摆设。
  if (row.matches(SELF_MARK)) return true;
  if (row.closest(ROOT) && !row.matches(SELF_MARK)) return false;
  return null;
}

export const adapter: SiteAdapter = {
  id: "<site>",
  probedAt: "2026-09-23",

  matches(url: string) {
    return new URL(url).host.endsWith("<报告里的站点域名>");
  },

  readSnapshot(doc: Document): ConversationSnapshot {
    const root = doc.querySelector(ROOT);
    if (!root) throw new LayoutChangedError(`message list not found (${ROOT})`);
    const rows = Array.from(root.querySelectorAll(ROW));
    if (rows.length === 0) throw new LayoutChangedError(`no message rows (${ROW})`);

    const messages: ChatMessage[] = rows.map((row, i) => {
      const text = (row.querySelector(BODY)?.textContent ?? "").replace(/\s+/g, " ").trim();
      const sender = row.querySelector(SENDER)?.textContent?.trim() || undefined;
      return {
        id: row.id || messageId(text, i, sender),
        text,
        sender,
        isSelf: direction(row),
        ts: 0, // 站点给了时间戳就填，报告第 2 节写明取法；没有就留 0
        mentionsMe: false,
      };
    }).filter((m) => m.text.length > 0);

    return {
      source: "<site>",
      conversationId: doc.location?.pathname ?? "",
      title: doc.querySelector("<报告里的会话名选择器>")?.textContent?.trim() ?? "",
      isGroup: rows.some((r) => r.querySelector(SENDER) !== null),
      messages,
      input: { canFill: doc.querySelector(INPUT) !== null },
    };
  },
};
```

- [ ] **Step 5: 跑测试直到全绿**

Run: `cd extension && npm test`
Expected: PASS，41 个测试通过

解析结果和 `expected.json` 对不上时，**先确认 expected.json 标注是对的**，再改适配器。
两边都改到刚好通过，测试就没有意义了。

- [ ] **Step 6: 提交**

```bash
git add extension/src/adapters extension/test/adapters.<site>.test.ts probe/web/<site>/expected.json
git commit -m "feat(adapters): 首站适配器与脱敏快照回归"
```

---

### Task 9: 调度器纯函数

**Files:**
- Create: `extension/src/scheduler/decide.ts`, `extension/test/scheduler.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `ConversationSnapshot`、`newestIncoming`
- Produces: `SchedulerState`、`initialState()`、
  `decide(state: SchedulerState, input: DecideInput): { state: SchedulerState; action: Action }`；
  `Action` 为 `{kind: "idle"}` / `{kind: "wait"}` / `{kind: "analyze"; message: ChatMessage; epoch: number}` /
  `{kind: "fuse"}`

- [ ] **Step 1: 写失败的测试**

创建 `extension/test/scheduler.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, decide, resetFuse, type DecideInput } from "../src/scheduler/decide.ts";
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
  let st = initialState();
  let messages: [string, boolean | null][] = [];
  let last = decide(st, at(0, snap(messages)));
  for (let i = 0; i < 21; i++) {
    messages = [...messages, [`m${i}`, false]];
    last = decide(last.state, at(1000 + i * 100, snap(messages)));
  }
  assert.equal(last.action.kind, "fuse");
});

test("a blown fuse stays blown until it is reset", () => {
  // conversationId 必须先对上，否则 decide 会当成换了会话而重置整个状态（连 fused 一起清掉）
  const st = { ...initialState(), conversationId: "c1", fused: true };
  assert.equal(decide(st, at(50_000, snap([["x", false]]))).action.kind, "idle");
});

test("resetFuse lets the same conversation analyse again", () => {
  const fused = { ...initialState(), conversationId: "c1", fused: true };
  let st = resetFuse(fused);
  st = decide(st, at(1000, snap([["back on", false]]))).state;
  assert.equal(decide(st, at(2300, snap([["back on", false]]))).action.kind, "analyze");
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cd extension && npm test`
Expected: FAIL，`Cannot find module '../src/scheduler/decide.ts'`

- [ ] **Step 3: 实现调度决策**

创建 `extension/src/scheduler/decide.ts`：

```ts
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
  };
}

export function decide(
  prev: SchedulerState, input: DecideInput,
): { state: SchedulerState; action: Action } {
  const { now, snapshot, tabActive } = input;
  let state = { ...prev };

  // a different conversation invalidates everything in flight
  if (state.conversationId !== snapshot.conversationId) {
    state = {
      ...initialState(),
      epoch: prev.epoch + 1,
      conversationId: snapshot.conversationId,
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
      return { state: { ...state, recentArrivals: arrivals, fused: true },
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

/** The panel's "resume" button: this conversation stops fusing for this tab's lifetime. */
export function resetFuse(state: SchedulerState): SchedulerState {
  return { ...state, fused: false, recentArrivals: [] };
}
```

- [ ] **Step 4: 跑测试与类型检查**

Run: `cd extension && npm test && npm run typecheck`
Expected: PASS，51 个测试通过

- [ ] **Step 5: 提交**

```bash
git add extension/src/scheduler extension/test/scheduler.test.ts
git commit -m "feat(scheduler): 触发、去重、停稳、作废与刷屏保险丝的纯函数"
```

---

### Task 10: 侧边栏与端到端串联

**Files:**
- Create: `extension/manifest.json`, `extension/scripts/build.mjs`,
  `extension/src/content.ts`, `extension/src/background.ts`,
  `extension/src/panel/index.html`, `extension/src/panel/panel.ts`,
  `extension/src/config.ts`, `extension/test/config.test.ts`,
  `docs/superpowers/probes/2026-09-23-manual-checklist.md`

**Interfaces:**
- Consumes: Task 5–9 的全部产出
- Produces: 可加载的未打包扩展；消息协议
  `{type: "snapshot", snapshot}`（content → background）、
  `{type: "verdict", verdict, epoch}`（background → panel）、
  `{type: "status", text}`、`{type: "fused"}`

- [ ] **Step 1: 写配置读取的失败测试**

创建 `extension/test/config.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickBackendKind, type StoredConfig } from "../src/config.ts";

test("a jev key wins over an openai key", () => {
  const cfg: StoredConfig = { jevKey: "j", jevBase: "", jevModel: "", llmKey: "o",
                              llmBase: "", llmModel: "", lang: "en" };
  assert.equal(pickBackendKind(cfg), "jev");
});

test("falls back to the generic llm when only that key is set", () => {
  const cfg: StoredConfig = { jevKey: "", jevBase: "", jevModel: "", llmKey: "o",
                              llmBase: "", llmModel: "", lang: "en" };
  assert.equal(pickBackendKind(cfg), "llm");
});

test("no key at all is reported as none, not guessed", () => {
  const cfg: StoredConfig = { jevKey: "", jevBase: "", jevModel: "", llmKey: "",
                              llmBase: "", llmModel: "", lang: "en" };
  assert.equal(pickBackendKind(cfg), "none");
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cd extension && npm test`
Expected: FAIL，`Cannot find module '../src/config.ts'`

- [ ] **Step 3: 实现配置模块**

创建 `extension/src/config.ts`：

```ts
import type { Lang } from "./definitions.ts";

export interface StoredConfig {
  jevKey: string;
  jevBase: string;
  jevModel: string;
  llmKey: string;
  llmBase: string;
  llmModel: string;
  lang: Lang;
}

export const DEFAULTS: StoredConfig = {
  jevKey: "", jevBase: "https://api.typesafe.ai", jevModel: "jev-latest",
  llmKey: "", llmBase: "https://api.deepseek.com", llmModel: "deepseek-chat",
  lang: "en",
};

/** Same precedence as the Python app: the key that is present decides the backend. */
export function pickBackendKind(cfg: StoredConfig): "jev" | "llm" | "none" {
  if (cfg.jevKey) return "jev";
  if (cfg.llmKey) return "llm";
  return "none";
}

export async function loadConfig(): Promise<StoredConfig> {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored } as StoredConfig;
}

export async function saveConfig(patch: Partial<StoredConfig>): Promise<void> {
  await chrome.storage.local.set(patch);
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `cd extension && npm test`
Expected: PASS，54 个测试通过

- [ ] **Step 5: 写清单、内容脚本、后台与面板**

创建 `extension/manifest.json`（`<site>` 与域名按 Task 8 的站点填）：

```json
{
  "manifest_version": 3,
  "name": "chat-jev",
  "version": "0.0.1",
  "description": "Reads the chat on screen and suggests replies. Read-only, never sends.",
  "permissions": ["storage", "sidePanel", "scripting", "activeTab"],
  "optional_host_permissions": ["https://<报告里的站点域名>/*"],
  "background": { "service_worker": "background.js", "type": "module" },
  "side_panel": { "default_path": "panel/index.html" },
  "action": { "default_title": "chat-jev" }
}
```

内容脚本不写进 `content_scripts`，改由后台在用户授权后用 `chrome.scripting` 注入——
这是「权限按站点申请」的落实方式。

创建 `extension/src/content.ts`：

```ts
import { pickAdapter } from "./adapters/registry.ts";

/**
 * The page-side eye: read the DOM, hand a snapshot to the background worker.
 * It never writes to the page and never logs message text.
 */
const adapter = pickAdapter(location.href);

function push(): void {
  if (!adapter) return;
  try {
    const snapshot = adapter.readSnapshot(document);
    chrome.runtime.sendMessage({ type: "snapshot", snapshot });
  } catch (e) {
    chrome.runtime.sendMessage({
      type: "status",
      text: e instanceof Error ? e.message : "read failed",
    });
  }
}

const observer = new MutationObserver(() => push());
observer.observe(document.body, { childList: true, subtree: true, characterData: true });
push();
```

创建 `extension/src/background.ts`：

```ts
import { loadConfig, pickBackendKind } from "./config.ts";
import { JevBackend } from "./backends/jev.ts";
import { LlmBackend } from "./backends/llm.ts";
import type { AnalysisBackend } from "./backends/types.ts";
import { decide, initialState, resetFuse, type SchedulerState } from "./scheduler/decide.ts";
import { validateSnapshot } from "./contracts/snapshot.ts";

let state: SchedulerState = initialState();

async function backend(): Promise<AnalysisBackend | null> {
  const cfg = await loadConfig();
  const kind = pickBackendKind(cfg);
  if (kind === "jev") {
    return new JevBackend({ base: cfg.jevBase, key: cfg.jevKey, model: cfg.jevModel,
                            lang: cfg.lang });
  }
  if (kind === "llm") {
    return new LlmBackend({ base: cfg.llmBase, key: cfg.llmKey, model: cfg.llmModel,
                            lang: cfg.lang });
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "resetFuse") {
    state = resetFuse(state);
    return;
  }
  if (msg?.type !== "snapshot") return;

  const checked = validateSnapshot(msg.snapshot);
  if (!checked.ok) {
    void chrome.runtime.sendMessage({ type: "status", text: `bad snapshot: ${checked.error}` });
    return;
  }

  const result = decide(state, {
    now: Date.now(),
    snapshot: checked.snapshot,
    tabActive: sender.tab?.active ?? false,
  });
  state = result.state;

  if (result.action.kind === "fuse") {
    void chrome.runtime.sendMessage({ type: "fused" });
    return;
  }
  if (result.action.kind !== "analyze") return;

  const { message, epoch } = result.action;
  void (async () => {
    const be = await backend();
    if (!be) {
      void chrome.runtime.sendMessage({ type: "status", text: "no API key configured" });
      return;
    }
    void chrome.runtime.sendMessage({ type: "status", text: "judging…" });
    try {
      const verdict = await be.judge({ text: message.text, context: null });
      if (epoch !== state.epoch) return;          // conversation changed under us
      void chrome.runtime.sendMessage({ type: "verdict", verdict, epoch });
    } catch (e) {
      void chrome.runtime.sendMessage({
        type: "status", text: e instanceof Error ? e.message : "judge failed",
      });
    }
  })();
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId !== undefined) void chrome.sidePanel.open({ windowId: tab.windowId });
});
```

创建 `extension/src/panel/index.html`：

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>chat-jev</title>
    <style>
      body { font: 13px -apple-system, system-ui, sans-serif; margin: 0; padding: 12px; }
      #status { color: #666; font-size: 12px; min-height: 16px; }
      #intent { font-size: 18px; font-weight: 600; margin: 8px 0 2px; }
      #risk { color: #b45309; margin-bottom: 8px; }
      #actions { margin: 0; padding-left: 18px; color: #333; }
      #fuse { display: none; background: #fef3c7; padding: 8px; border-radius: 6px; }
    </style>
  </head>
  <body>
    <div id="status">waiting for a message…</div>
    <div id="fuse">
      This conversation is very busy, automatic analysis is paused.
      <button id="resume">Resume</button>
    </div>
    <div id="intent"></div>
    <div id="risk"></div>
    <ul id="actions"></ul>
    <script type="module" src="panel.js"></script>
  </body>
</html>
```

创建 `extension/src/panel/panel.ts`。意图直接按 `shared/definitions.json` 的键显示
（英文就是 `chase` 这样的词）；更好看的展示文案属于第 7 期的文案工作，本期不做。


```ts
import type { Verdict } from "../backends/types.ts";

const $ = (id: string) => document.getElementById(id)!;

function render(v: Verdict): void {
  $("intent").textContent = v.intent;
  // risk 0 means "not computed" on the llm backend — show nothing rather than a fake 0
  $("risk").textContent = v.risk > 0 ? `risk ${v.risk.toFixed(1)} / 9` : "";
  $("actions").innerHTML = "";
  for (const a of v.actions) {
    const li = document.createElement("li");
    li.textContent = a;
    $("actions").append(li);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "verdict") {
    $("status").textContent = "";
    $("fuse").style.display = "none";
    render(msg.verdict as Verdict);
  } else if (msg?.type === "status") {
    $("status").textContent = String(msg.text);
  } else if (msg?.type === "fused") {
    $("fuse").style.display = "block";
  }
});

$("resume").addEventListener("click", () => {
  void chrome.runtime.sendMessage({ type: "resetFuse" });
  $("fuse").style.display = "none";
});
```

创建 `extension/scripts/build.mjs`：

```js
import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

await build({
  entryPoints: ["src/background.ts", "src/content.ts", "src/panel/panel.ts"],
  bundle: true,
  format: "esm",
  target: "chrome120",
  outdir: "dist",
  outbase: "src",
});
mkdirSync("dist/panel", { recursive: true });
cpSync("manifest.json", "dist/manifest.json");
cpSync("src/panel/index.html", "dist/panel/index.html");
console.log("built dist/ — 在 chrome://extensions 里「加载已解压的扩展程序」选它");
```

- [ ] **Step 6: 构建并类型检查**

Run: `cd extension && npm run build && npm run typecheck`
Expected: `dist/` 下有 `manifest.json`、`background.js`、`content.js`、`panel/panel.js`、
`panel/index.html`；typecheck 无输出

- [ ] **Step 7: 端到端手测**

创建 `docs/superpowers/probes/2026-09-23-manual-checklist.md`，内容为下面这份清单，
逐条勾选并把结果写进去：

1. `chrome://extensions` 打开开发者模式，加载 `extension/dist`。
2. 打开首站的一个测试会话，点扩展图标打开侧边栏，按提示授予该站点权限。
3. 在 DevTools 控制台执行一次 `chrome.storage.local.set({llmKey: "...", llmBase: "...", llmModel: "..."})`
   填入 key（设置界面是后续任务的事）。
4. 让测试对象发一条消息 → 侧边栏在几秒内显示意图与行动建议。
5. 连发三条 → 只出现一次判断，且针对最后一条。
6. 自己回一条 → 面板不再挂着上一条的判断。
7. 切到另一个会话 → 上一个会话的在途结果不会串台显示。
8. 一分钟内快速发 21 条 → 面板出现保险丝提示，点 Resume 后恢复。
9. 在页面上删掉消息容器（控制台 `document.querySelector(ROOT).remove()`）→
   面板显示 `layout changed`，不是静默空白。
10. 全程检查：扩展没有往页面写任何东西，控制台没有打印消息正文。

- [ ] **Step 8: 提交**

```bash
git add extension/manifest.json extension/scripts/build.mjs extension/src/content.ts \
        extension/src/background.ts extension/src/panel extension/src/config.ts \
        extension/test/config.test.ts docs/superpowers/probes/2026-09-23-manual-checklist.md
git commit -m "feat(panel): 侧边栏与端到端串联，第 2 期骨架打通"
```

- [ ] **Step 9: 确认 Python 侧毫发无损**

Run: `uv run python -B -m unittest discover -s tests`
Expected: 全部通过

Run: `git diff --stat master -- src/judge.py src/generate.py src/hud.py src/perception.py`
Expected: 空输出——本期只新增文件，没有改动任何现有模块

---

## 本期完成标准

- 英文判断三个后端有实测数字，默认后端有结论，写在探测报告里。
- 五个站点的消息容器、方向信号、填入手段有记录，首站已选定。
- `shared/definitions.json` 的中文部分与现有代码逐字一致，有测试守着。
- 扩展能在首站读出消息、调云端判断、在侧边栏显示意图与行动建议。
- 去重、停稳、作废、保险丝四条调度规则各有测试。
- 现有 Python 代码与测试一行未改、一条未退。

第 3 期开始前重读探测报告：如果英文准确率低于中文口径太多，第 8 节的默认后端和
8 类意图体系要先重新讨论，不要直接往下铺站点。
