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
    // Same typeof guard as risk one line up, for the same reason: `Number(x)`
    // on a gateway that answered "high" is NaN, which is neither a confidence
    // nor a missing one. Absent or unusable means null — nobody computed it.
    const confidence = typeof intentAns["confidence"] === "number"
      ? intentAns["confidence"] : null;
    return {
      intent,
      confidence,
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
        prob: probs[text] ?? (ans["choice"] === text && typeof ans["confidence"] === "number"
          ? (ans["confidence"] as number) : 0),
      }))
      .sort((a, b) => b.prob - a.prob);
  }
}
