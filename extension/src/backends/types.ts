import type { Lang } from "../definitions.ts";

export interface Verdict {
  intent: string;
  /**
   * `null` when the backend does not produce one — not 0, and never a stand-in
   * like 1.0 for "the letter parsed". A number here is a number somebody
   * computed (spec, section 8); the panel shows nothing when it is null.
   */
  confidence: number | null;
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
