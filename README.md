# chat-jev.com (macOS)

**English** · [简体中文](README.zh-CN.md)

A WeChat message arrives → a floating panel immediately tells you **what it actually wants**, **how risky it is**, and **how to reply**.

**Strictly read-only, no account-ban risk** — no injection, no hooking, no database decryption. It only reads the screen and judges locally.

## What it does

- **Intent + risk**: 8 intent classes, **86.4%** zero-shot (22-case regression); risk graded 0–9 with suggested actions, the full distribution from a single forward pass of a local model
- **Reply candidates**: 10 built-in tones generated concurrently (2 per tone, one safe and one bold) → shown immediately → reordered in place once the local model ranks them; switching tones regenerates against the current message right away
- **Fast**: judging and generation start together the moment a message appears. On an M1 Pro, intent in ~1.5 s, candidates in ~1.5–2 s (end-to-end figures are derived from the mechanism; trust the logs over this line)
- **YOLO detection boxes** (optional, `JEV_BOXES=1` at launch or toggled from the menu bar): OCR-matched messages are boxed live on the WeChat window, colour-coded by sender, with confidence

## Reading the panel

The panel uses the native macOS light frosted material. The top shows the current chat, analysis state, the message being processed and its context; the middle shows intent, recognition rate, risk level and suggested actions; the bottom groups reply candidates by tone. The current risk dot breathes gently. Each candidate shows its local ranking probability on the left and still only **Copy** and **Fill** on the right; candidate rows grow to fit the full text rather than truncating it, and sending is always done by you, by hand, in WeChat.

A tone slot set to "off" keeps only its dropdown — it generates nothing and occupies no candidate row. Enabling or disabling a tone changes only the panel height, never the judging or polling flow. The yellow window button collapses the panel to the chat name and status; the red one quits.

## Usage

**Just want to use it**: download the `.app` from [Releases](https://github.com/buildforpeople4iv/chat-jev-mac/releases/latest/download/chat-jev-macos-latest.zip), unzip it into Applications, and **right-click → Open the first time** (it is not notarized, so a double-click is blocked by Gatekeeper).

If the dialog says **"is damaged and can't be opened. You should move it to the Trash"** (common for zips downloaded in a browser, and right-click-open does not get around it), do not delete it — clear the quarantine attribute in a terminal:

```bash
sudo xattr -r -d com.apple.quarantine /Applications/chat-jev.app
```

If you renamed the `.app` (to "chat-jev 2.app", say), substitute the actual path.

On first launch, grant **Screen Recording** when prompted (System Settings › Privacy & Security › Screen & System Audio Recording, enable **chat-jev**), then **quit and reopen** for it to take effect. **Fill** additionally needs **Accessibility**; the system prompt appears the first time you use it. On v0.3.1 and earlier you also need to enable the **python3.12** entry.

When no usable `uv` is present, both launch paths first download and run the official installer script (the download has a timeout and retries), falling back to an existing Homebrew install. Failure messages distinguish network, certificate, disk and installer errors; full output goes to `~/Library/Logs/chat-jev.log`. The official script installs to `~/.local/bin` and does not modify your shell config.

**From source** (WeChat running, terminal granted Screen Recording): `./start.command`. Per-layer self-checks:

```bash
uv run python src/perception.py                  # perception layer: messages recognised + timings
uv run python src/judge.py "这个需求你今天跟一下"  # judge a single message
uv run python src/judge_zh_test.py               # 22-case Chinese intent regression
uv run python src/generate.py --check            # generation-layer credential resolution
uv run python -B -m unittest discover -s tests   # outgoing-message / async-result regression (synthetic OCR, no screen reads)
uv run python probe/bootstrap_regression.py      # offline regression for both launch paths; no network, no real install
```

## Configuration

Two layers, two keys. The judging layer falls back to the local `decider-2b` if you leave it empty (~7 GB on first download). **The generation layer must be configured yourself** — this distribution ships no shared channel, so without a key there are no reply candidates. See [PRIVACY.md](PRIVACY.md) for where data goes. Everything lives in one env file (**there is no second format**):

### Settings window (#18)

Click the **gear icon (Model Settings)** at the top right of the panel, or **J → Model Settings…** in the menu bar, to edit the Jev, OpenAI-compatible and Anthropic-compatible key groups, endpoints and models. The settings window sits above the panel and is never covered by it. **You must quit and reopen the app after saving**; saving does not switch the configuration of the current run.

- The window edits `$XDG_CONFIG_HOME/chat-jev/env` (or `~/.config/chat-jev/env` when unset) and shows the exact path. It changes only the fields of the service being edited, preserving other settings, comments and unrecognised lines, and sets the file mode to `600`. If another program modifies the file, it refuses to overwrite and asks you to reopen the window.
- Fill in the endpoint and key, click **Fetch model list** to pull from that service's `/models` endpoint, then pick from the dropdown; no model list is hardcoded. Jev reads the official `models[].name` (the current list is aliases; unlisted version numbers can still be typed in); OpenAI/Anthropic read `data[].id`. When the endpoint does not support it, fails, or returns an empty list, it says so plainly and you can still type a name — it never silently switches model or service. An empty dropdown shows "none" (a hint only; it is never saved or called). The status line at the bottom shows progress in blue, success in green, errors in red. Being listed does not guarantee generation access — test after selecting.
- **Test connection** uses the **unsaved** endpoint, key and model currently in the window to make a real call. It sends a fixed greeting only and never reads WeChat content; it may incur a small service charge. The generation layer must return non-empty text to count as success — a successful `--check` config parse is not a successful connection.
- Keys are masked. The window reads only the values in the file it is editing; it never copies environment variables or the project `.env` into your user file. The top of each page highlights whether this run is using your own key or local judging, and where it came from; the generation page also names the active service, with precedence shown at the bottom of the window.
- Environment variables take precedence over the user env file, which takes precedence over the project `.env`. In the generation layer the OpenAI group wins over the Anthropic group; with neither configured, generation is unavailable. Clearing the key in the current file does not disable keys from other sources. Values exported by a terminal or launcher also display as "environment variable".
- The API format follows the key group: `OPENAI_*` uses the OpenAI shape, `ANTHROPIC_*` the Anthropic shape; custom endpoints need not contain the service name. For Ollama use `http://localhost:11434/v1` with key `ollama`, and fetch or type the model. A Jev endpoint works with or without a trailing `/v1` — the same composition rule as manual configuration.
- Keychain: no new keychain reads or writes. If your existing env supplies a key through a shell expression such as `$(security find-generic-password …)`, the window neither evaluates nor displays it, and keeps the original line when you type no new key; your existing launcher still evaluates it. To test that service from the window you must type a key explicitly, and saving replaces the expression with what you typed. Externally injected keys keep following environment-variable precedence.
- `JEV_BOXES`, `JEV_TONES` and `OPENAI_EXTRA_BODY` are still env-only and untouched by the settings window. The OpenAI connection test reuses the `OPENAI_EXTRA_BODY` of the current run. Full tone management is left to a later change.

You can also keep editing by hand:

```bash
mkdir -p ~/.config/chat-jev
cat > ~/.config/chat-jev/env <<'ENV'
# Judging layer (optional): TypeSafe Jev. Leave empty to use the local decider-2b.
export TYPESAFE_API_KEY=""

# Generation layer: any OpenAI-compatible endpoint
export OPENAI_API_KEY="sk-your-key"
export OPENAI_BASE_URL="https://api.deepseek.com"
export OPENAI_MODEL="deepseek-chat"
# Set this when the endpoint needs an extra field to turn thinking off
# (Qwen3-class models are dozens of times slower with it on)
# export OPENAI_EXTRA_BODY='{"enable_thinking":false}'
ENV
chmod 600 ~/.config/chat-jev/env
```

- **The key decides everything**: whichever source supplies the key also determines the endpoint and the model. Verified working: DeepSeek `deepseek-chat` (fastest); Zhipu `glm-4-flash` (via `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`/`ANTHROPIC_MODEL` — with both groups set, OpenAI wins); local Ollama `qwen2.5:7b` (never leaves your machine)
- **Judging-layer gateways**: three spellings of `TYPESAFE_BASE_URL` are equivalent — host only (`https://api.typesafe.ai`), with a version segment (`…/v1`, the action segment is appended, never producing `/v1/v1/…`), or a full action path (used verbatim, nothing appended). For a third-party TypeSafe-compatible gateway, use the gateway's endpoint and key and name the model as the gateway does (for example Vercel AI Gateway: `https://ai-gateway.vercel.sh/v1/evaluate`, model `typesafe-ai/jev`)
- **Do not use thinking models**: reasoning eats the whole `max_tokens`, you get zero candidates, and the panel just reports a generation failure — on DeepSeek, stick to `deepseek-chat`
- **Custom tones**: add a `JEV_TONES` line to your env (`|`-separated, each `name=description`; a built-in name is overridden; takes effect on restart), e.g. `摸鱼大师=像资深摸鱼选手，把活推得漂亮又不失礼`. Descriptions work best when they state both the voice and what it must not turn into
- Check credentials without printing full keys: `uv run python src/generate.py --check`, `uv run python src/judge_jev.py`

## Disk usage and cleanup

| What | Where | Size | Cleanup |
|---|---|---|---|
| Local judging model `decider-2b` (downloaded only when no judging-layer key is set; shared by judging and ranking) | `~/.cache/huggingface/hub/models--Mapika--decider-2b` | ~7 GB | `rm -rf ~/.cache/huggingface/hub/models--Mapika--decider-2b`; it re-downloads next time local judging runs |
| Python runtime (venv) | `~/Library/Application Support/chat-jev/venv` | ~0.7 GB | Deleting the `.app` does not remove it; delete it by hand |

With Ollama as the generation layer, models live in Ollama's own directory (`~/.ollama`) and are not downloaded by this project.

## Known limitations

- Sender direction is inferred from text position. Text that spans both sides, is centred, or is otherwise unconfirmable is marked "direction unconfirmed" and is **never treated as a reply target** (a very wide incoming message may be skipped). Only messages positively identified as incoming trigger judging and generation; when only your own messages are visible the panel shows "waiting for a confirmable incoming message…"
- Images and stickers cannot be read; quoted replies are treated as plain text; article cards may be read as messages; recognition may fail in WeChat's full-screen layout (layout constants need to become dynamic, see #17)
- A WeChat redesign invalidates the layout constants (the constants at the top of `src/perception.py` need recalibrating); with multiple windows, the main "微信 / WeChat" window wins
- The first judgement after launch is slow by design (local model warm-up). When something looks wrong, read the log first — it records per-stage timings and **never message text**, so it is safe to paste into an issue: `tail -40 ~/Library/Logs/chat-jev.log`

## Input-box detection and Fill

The menu bar's **YOLO detection boxes** show both message boxes and the fill target, refreshing about once a second: a solid blue box is the input control located through the Accessibility API, an orange dashed box is an input area inferred from the screenshot bounds, and when neither works it tells you why. A dashed box does not mean a writable control was obtained, and it does not fix the fixed-ratio chat-area problem in #17.

**Fill** writes through the Accessibility API first and reads the value back to confirm. On WeChat versions that expose no input control, clicking **Fill** explicitly falls back to a visual path: re-check the window, input area and title, activate WeChat, click the input area, type the text, then verify by OCR. That path needs both Screen Recording and Accessibility, and it moves the mouse — do not touch the keyboard or mouse, or switch chats, while it runs. It never presses send, and never uses the clipboard or Cmd+V; newlines and tabs become spaces.

The fallback path stops when it finds an existing draft and tells you to use **Copy** instead; the Accessibility path still appends to existing text. Both stop when the window, focus or conversation changes, and when the screen cannot be verified they tell you to check the draft rather than retrying. Visual bounds and OCR can both misread, and a title check is not a conversation ID, so a race with your own typing cannot be ruled out. Dark mode, multiple displays and other WeChat versions still need more testing.

## Next steps (in priority order)

1. **Collect labelled data**: record misjudgements — especially "chasing progress vs asking progress" — and fine-tune toward 95%+
2. **Tell chat messages from shared article cards**: filter conservatively; the risk is dropping real messages

## For developers

- **Read before contributing**: [CONTRIBUTING.md](CONTRIBUTING.md) — claim an issue before touching code (comment + assignee), and run the self-check for whichever layer you changed
- Settings-window self-check: `uv run python -B -m unittest discover -s tests`; native window and button flow: `uv run python -B probe/settings_smoke.py` (temporary config plus a local test server, never your own keys)
- Build with `./packaging/build_app.sh`; release with `./packaging/release.sh --publish` (clean-worktree build + unzip verification + gh release). The version number lives in `pyproject.toml` and nowhere else; with a developer certificate, add `--sign "Developer ID Application: ..."`
- Architecture in one line: capture the WeChat window in-process → Vision OCR (chat area only) → local `decider-2b` for intent and risk → concurrent LLM candidates → local ranking → an `NSPanel` floating window. It captures the window, not the screen: WeChat can be covered, and the panel never pollutes the OCR
- **Browser extension (`extension/`, in development, independent of the macOS app above)**: brings the same intent / risk / suggested-action analysis to web chat (WhatsApp Web, Telegram Web, Slack, Discord, Teams). Equally read-only and it never sends on your behalf, but **its judging layer is cloud-only** — there is no local-model option. Installation, the permission model, the diagnostic view and known limitations are in [extension/README.md](extension/README.md)

## Origin and licence

This project is derived from [jev-chat/jev-chat-jarvis-mac](https://github.com/jev-chat/jev-chat-jarvis-mac)
(MIT, Copyright (c) 2026 eatmoreduck), whose licence and copyright notice are retained in full.
It forks from upstream `5b6e70a`; to avoid redistributing the upstream author's relay credential
through git history, the history has been squashed into a single initial commit — the complete
upstream history is in the upstream repository. The main differences from upstream:

- The built-in shared relay channel is removed; every key is now your own (upstream's channel ran through the original author's server and is not redistributed here)
- A browser extension `extension/` is added, extending the capability from WeChat on the desktop to web chat

MIT (see `LICENSE`). It reads **only the chat on your own screen, in your own account** — no injection, no hooking, no database decryption, and it never sends anything on its own. Use it on your own device; installing it on someone else's machine to read their chats is a different matter, and this project does not endorse that. A WeChat redesign may break layout recognition. Please comply with the WeChat software licence agreement.

**Privacy and data flow** are detailed in [PRIVACY.md](PRIVACY.md): chat text goes only to the model provider you configure — you must supply your own API key, or run Ollama locally so nothing leaves your machine.
