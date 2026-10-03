/**
 * Adapter selection. Site-specific adapters (written from diagnostic reports
 * once real sites have been probed) register themselves here, ahead of the
 * generic fallback; `pickAdapter` returns the first one whose `matches(url)`
 * claims the page, falling back to `genericAdapter` when none do.
 *
 * Today the registry is empty, so every url falls through to `genericAdapter` —
 * that is the expected, correct behavior until a site adapter is added.
 */

import type { SiteAdapter } from "./types.ts";
import { genericAdapter } from "./generic.ts";

const SITE_ADAPTERS: SiteAdapter[] = [];

export function pickAdapter(url: string): SiteAdapter {
  for (const adapter of SITE_ADAPTERS) {
    if (adapter.matches(url)) return adapter;
  }
  return genericAdapter;
}
