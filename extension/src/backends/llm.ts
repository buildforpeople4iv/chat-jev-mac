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
    const intent = idx === null ? fallbackIntent(lang) : names[idx]!;
    return {
      intent,
      // Always null: this backend answers with a single letter and no
      // probability at all. Reporting 1.0 because the letter parsed would be a
      // number nobody computed — the same rule that keeps risk and ranking
      // blank here (spec, section 8).
      confidence: null,
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
