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
