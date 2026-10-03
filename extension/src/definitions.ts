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
