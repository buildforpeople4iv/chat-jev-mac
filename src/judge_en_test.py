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

# A bracketed letter is an unambiguous, explicitly marked answer — checked first so
# it wins over any bare single-letter English word ("a", "I") that happens to occur
# earlier in a hedged sentence like "As a starting point, ... (D) is correct."
_BRACKETED_RE = re.compile(r"[（(\[]\s*([A-Za-z])\s*[)）\]]")
# Second choice: a letter right after the word "answer", with no bracket required
# ("answer: e"). \W* (not \w*) stops at the next word so "answer is correct" doesn't
# walk past "is" looking for a letter.
_PREFIXED_RE = re.compile(r"(?i)\banswer\b[^A-Za-z0-9]*([A-Za-z])\b")


def parse_letter_answer(text: str, n_options: int) -> int | None:
    """Index of the option a free-text answer picked, or None when it picked nothing.

    Chat models answer "B", "(B)", "Answer: **(B)**" and every mix of those, but also
    hedge with prose around the real answer ("I'd say (D) is correct"). A bracketed
    or "answer:"-prefixed letter is trusted over a bare one; a bare letter only counts
    when it effectively *is* the whole reply, not when it's a stray English article
    ("a") or pronoun ("I") sitting earlier in a sentence. Anything left over without
    a letter in range is a miss, not a guess — a silently wrong index would show up
    as a model accuracy problem rather than a parsing problem.
    """
    stripped = re.sub(r"[*_#`]", "", text or "").strip()
    m = _BRACKETED_RE.search(stripped) or _PREFIXED_RE.search(stripped)
    if m:
        letter = m.group(1)
    elif len(stripped) == 1 and stripped.isalpha():
        letter = stripped
    else:
        return None
    idx = LETTERS.find(letter.upper())
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
