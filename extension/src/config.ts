/**
 * User-editable configuration, stored in chrome.storage.local. This is the only
 * place backend selection precedence is decided — background.ts reads it via
 * loadConfig()/pickBackendKind() and never inspects chrome.storage directly.
 */

import type { Lang } from "./definitions.ts";

export interface StoredConfig {
  jevKey: string; jevBase: string; jevModel: string;
  llmKey: string; llmBase: string; llmModel: string;
  lang: Lang;
}

export const DEFAULTS: StoredConfig = {
  jevKey: "", jevBase: "https://api.typesafe.ai", jevModel: "jev-latest",
  llmKey: "", llmBase: "https://api.deepseek.com", llmModel: "deepseek-chat",
  lang: "en",
};

/** Same precedence as the Python app: whichever key is present decides the backend. */
export function pickBackendKind(cfg: StoredConfig): "jev" | "llm" | "none" {
  if (cfg.jevKey.trim()) return "jev";
  if (cfg.llmKey.trim()) return "llm";
  return "none";
}

export async function loadConfig(): Promise<StoredConfig> {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored } as StoredConfig;
}

export async function saveConfig(patch: Partial<StoredConfig>): Promise<void> {
  await chrome.storage.local.set(patch);
}
