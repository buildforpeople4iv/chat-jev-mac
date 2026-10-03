/**
 * Presentation only. This file never judges, never schedules, never talks to
 * an analysis backend — it renders what background.ts sends and forwards two
 * user actions back to it (resetFuse, requestDiagnostic). It does own one
 * piece of logic that is legitimately the panel's: the "enable on this site"
 * button, because chrome.permissions.request() must be called synchronously
 * from within a user-gesture handler, which only a UI surface like this one
 * has.
 *
 * Side panel lifecycle note (see task report for the full reasoning): unless
 * a panel is bound per-tab with chrome.sidePanel.setOptions(), one panel
 * document is shared by every tab in its window and is *not* reloaded when
 * the active tab changes — so this script must notice tab switches itself
 * (chrome.tabs.onActivated, filtered to this panel's own window) rather than
 * relying on a fresh page load to pick up the new tab's state.
 */

import type { Verdict } from "../backends/types.ts";
import type { AdapterDiagnostic } from "../adapters/types.ts";
import { loadConfig, saveConfig, DEFAULTS, type StoredConfig } from "../config.ts";
import type { Lang } from "../definitions.ts";

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`panel markup is missing #${id}`);
  return el;
}

function send(message: unknown): void {
  void chrome.runtime.sendMessage(message).catch(() => {});
}

// ---------------------------------------------------------------------------
// Analysis section
// ---------------------------------------------------------------------------

function clearAnalysis(statusText: string): void {
  $("status").textContent = statusText;
  ($("fuse") as HTMLElement).style.display = "none";
  $("convTitle").textContent = "";
  $("intent").textContent = "";
  $("risk").textContent = "";
  $("actions").innerHTML = "";
}

function renderVerdict(v: Verdict, title: string | undefined): void {
  $("status").textContent = "";
  ($("fuse") as HTMLElement).style.display = "none";
  $("convTitle").textContent = title ?? "";
  $("intent").textContent = v.intent;
  // risk 0 means "not computed" (the generic llm backend cannot produce one) —
  // show nothing rather than a fabricated number. Spec section 8.
  $("risk").textContent = v.risk > 0 ? `risk ${v.risk.toFixed(1)} / 9` : "";
  $("actions").innerHTML = "";
  for (const a of v.actions) {
    const li = document.createElement("li");
    li.textContent = a;
    $("actions").append(li);
  }
}

$("resume").addEventListener("click", () => {
  send({ type: "resetFuse" });
  ($("fuse") as HTMLElement).style.display = "none";
});

// ---------------------------------------------------------------------------
// Diagnostic section
// ---------------------------------------------------------------------------

let currentDiagnostic: AdapterDiagnostic | null = null;

function renderDiagnostic(d: AdapterDiagnostic): void {
  currentDiagnostic = d;
  $("diagnosticJson").textContent = JSON.stringify(d, null, 2);
}

function showCopyNote(text: string): void {
  const note = $("copyStatus");
  note.textContent = text;
  setTimeout(() => { note.textContent = ""; }, 2500);
}

$("copyDiagnostic").addEventListener("click", () => {
  if (!currentDiagnostic) {
    showCopyNote("nothing to copy yet");
    return;
  }
  const json = JSON.stringify(currentDiagnostic, null, 2);
  void navigator.clipboard.writeText(json).then(
    () => showCopyNote("copied"),
    () => {
      // Clipboard API can be unavailable in some embedding contexts; fall
      // back to a manual select so the user can still Cmd/Ctrl+C it.
      const pre = $("diagnosticJson");
      const range = document.createRange();
      range.selectNodeContents(pre);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      showCopyNote("auto-copy failed — text is selected, press Cmd/Ctrl+C");
    },
  );
});

$("refreshDiagnostic").addEventListener("click", () => requestDiagnosticForCurrentTab());

// ---------------------------------------------------------------------------
// Site enablement ("optional_host_permissions" + explicit user click, per the
// hard requirement: no site gets scripting.executeScript without this)
// ---------------------------------------------------------------------------

let currentTabId: number | undefined;
let currentWindowId: number | undefined;
let currentOrigin: string | null = null;

function computeOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * The sites the manifest is willing to ask for. Read from the manifest rather
 * than duplicated here, so the list has exactly one home. chrome.permissions
 * .request() rejects for anything outside optional_host_permissions, so
 * offering the button on another site would only produce a confusing failure.
 */
function supportedOrigins(): string[] {
  const m = chrome.runtime.getManifest() as { optional_host_permissions?: string[] };
  return m.optional_host_permissions ?? [];
}

function isSupported(origin: string): boolean {
  return supportedOrigins().includes(`${origin}/*`);
}

async function refreshSiteRow(): Promise<void> {
  const enableBtn = $("enableSite") as HTMLButtonElement;
  const originEl = $("siteOrigin");
  const hintEl = $("siteHint");

  if (currentTabId === undefined || !currentOrigin) {
    originEl.textContent = "";
    hintEl.textContent = "This page is not a supported site (only https:// pages).";
    enableBtn.disabled = true;
    enableBtn.textContent = "Enable on this site";
    return;
  }

  originEl.textContent = currentOrigin;
  if (!isSupported(currentOrigin)) {
    const hosts = supportedOrigins()
      .map((p) => p.replace(/^https:\/\//, "").replace(/\/\*$/, ""))
      .join(", ");
    hintEl.textContent = `chat-jev only asks for these sites: ${hosts}.`;
    enableBtn.disabled = true;
    enableBtn.textContent = "Enable on this site";
    return;
  }
  const pattern = `${currentOrigin}/*`;
  try {
    const already = await chrome.permissions.contains({ origins: [pattern] });
    enableBtn.disabled = already;
    enableBtn.textContent = already ? "Enabled" : "Enable on this site";
    hintEl.textContent = already
      ? ""
      : "Click to let chat-jev read this site's chat (nothing runs until you do).";
  } catch {
    // chrome.permissions.contains() rejecting is not expected, but this
    // function is called both fire-and-forget (from click handlers and the
    // tab-switch listener) and awaited (from loadTabContext) — it must never
    // reject either way. Degrade to a safe, re-clickable state.
    enableBtn.disabled = false;
    enableBtn.textContent = "Enable on this site";
    hintEl.textContent = "Could not check this site's permission status.";
  }
}

$("enableSite").addEventListener("click", () => {
  // chrome.permissions.request() must be invoked synchronously inside this
  // gesture handler — no await before the call.
  if (!currentOrigin || currentTabId === undefined) return;
  const pattern = `${currentOrigin}/*`;
  const tabId = currentTabId;
  void chrome.permissions.request({ origins: [pattern] }).then(async (granted) => {
    if (!granted) {
      $("siteHint").textContent = "Permission was not granted.";
      return;
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    } catch {
      $("siteHint").textContent = "Could not read this page (unsupported page type).";
      return;
    }
    void refreshSiteRow();
  }).catch(() => {
    $("siteHint").textContent = "Could not request permission for this site.";
  });
});

async function loadTabContext(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id;
  currentWindowId = tab?.windowId;
  currentOrigin = computeOrigin(tab?.url);
  await refreshSiteRow();
}

function requestDiagnosticForCurrentTab(): void {
  send({ type: "requestDiagnostic", windowId: currentWindowId });
}

// ---------------------------------------------------------------------------
// Settings section
// ---------------------------------------------------------------------------

function fieldsFromConfig(cfg: StoredConfig): void {
  ($("jevKey") as HTMLInputElement).value = cfg.jevKey;
  ($("jevBase") as HTMLInputElement).value = cfg.jevBase;
  ($("jevModel") as HTMLInputElement).value = cfg.jevModel;
  ($("llmKey") as HTMLInputElement).value = cfg.llmKey;
  ($("llmBase") as HTMLInputElement).value = cfg.llmBase;
  ($("llmModel") as HTMLInputElement).value = cfg.llmModel;
  ($("lang") as HTMLSelectElement).value = cfg.lang;
}

$("saveConfig").addEventListener("click", () => {
  const val = (id: string) => ($(id) as HTMLInputElement).value;
  const patch: Partial<StoredConfig> = {
    jevKey: val("jevKey").trim(),
    jevBase: val("jevBase").trim() || DEFAULTS.jevBase,
    jevModel: val("jevModel").trim() || DEFAULTS.jevModel,
    llmKey: val("llmKey").trim(),
    llmBase: val("llmBase").trim() || DEFAULTS.llmBase,
    llmModel: val("llmModel").trim() || DEFAULTS.llmModel,
    lang: (($("lang") as HTMLSelectElement).value as Lang) || DEFAULTS.lang,
  };
  void saveConfig(patch).then(() => {
    const note = $("saveStatus");
    note.textContent = "saved";
    setTimeout(() => { note.textContent = ""; }, 2000);
  }).catch(() => {
    const note = $("saveStatus");
    note.textContent = "save failed";
    setTimeout(() => { note.textContent = ""; }, 2500);
  });
});

// ---------------------------------------------------------------------------
// Messages from background.ts
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg: unknown) => {
  const m = msg as { type?: unknown; [key: string]: unknown } | null;
  if (!m || typeof m.type !== "string") return;

  if (m.type === "verdict") {
    renderVerdict(m["verdict"] as Verdict, m["title"] as string | undefined);
  } else if (m.type === "status") {
    $("status").textContent = String(m["text"] ?? "");
    const title = m["title"];
    if (typeof title === "string" && title) $("convTitle").textContent = title;
  } else if (m.type === "fused") {
    ($("fuse") as HTMLElement).style.display = "block";
  } else if (m.type === "diagnostic") {
    renderDiagnostic(m["diagnostic"] as AdapterDiagnostic);
  }
});

// ---------------------------------------------------------------------------
// Tab-switch handling — see the lifecycle note at the top of this file.
// ---------------------------------------------------------------------------

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (activeInfo.windowId !== currentWindowId) return; // a different window's tab bar
  currentTabId = activeInfo.tabId;
  clearAnalysis("waiting for a message…");
  $("diagnosticJson").textContent = "no diagnostic yet";
  currentDiagnostic = null;
  void chrome.tabs.get(activeInfo.tabId).then((tab) => {
    currentOrigin = computeOrigin(tab.url);
    void refreshSiteRow();
  }).catch(() => {
    // The tab closed between the activation event and this lookup — nothing
    // to resync; the next activation event (or the next tab) will.
  });
  requestDiagnosticForCurrentTab();
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

void (async () => {
  try {
    fieldsFromConfig(await loadConfig());
    await loadTabContext();
    requestDiagnosticForCurrentTab();
  } catch (e) {
    // loadConfig()/loadTabContext() touch chrome.storage and chrome.tabs; a
    // failure here must not vanish as an unhandled rejection — it would leave
    // the whole panel silently inert with no error visible anywhere.
    $("status").textContent = e instanceof Error ? e.message : "failed to load panel state";
  }
})();
