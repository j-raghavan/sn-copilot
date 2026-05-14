# Copilot Plugin for Supernote

![Tests](https://img.shields.io/badge/tests-1000%20passed-brightgreen)
![Coverage](https://img.shields.io/badge/coverage-99%25%20lines%20%2F%2097%25%20branches-brightgreen)
![Lint](https://img.shields.io/badge/lint-passing-brightgreen)
![Platform](https://img.shields.io/badge/platform-Supernote-blue)
![License](https://img.shields.io/badge/license-MIT-blue)
![Version](https://img.shields.io/badge/version-1.0.3-blue)

An on-device AI chat sidebar for Supernote notes, PDFs, and EPUBs. Tap the **Copilot** button on the sidebar, ask the model to summarise the page, explain a section, or answer a question — the page screenshot and any extracted text go to the LLM you configured, and the reply lands in a panel on the right edge of the screen.

## Privacy is yours, not ours

This plugin has **no backend**. It does not run a service, route your traffic through anyone's server, or hold a key on your behalf. You bring your own API key for Anthropic, OpenAI, Google Gemini, or DeepSeek; the plugin places your request directly against that provider's API and shows the response.

**What that means concretely:**

- **You own the key.** It lives in a text file in `MyStyle/SnCopilot/` on your device — created by you, never uploaded by us, never copied off the device by the plugin. You can [optionally encrypt it with a PIN](#optional-encrypt-your-key-with-a-pin) so other plugins on the same device can't read it.
- **You own the conversation.** Requests go from your device to the provider you chose. We never see them. There is no "Copilot history" stored anywhere outside your provider's account.
- **You own the audit.** Every billable request shows up on **your** OpenAI / Anthropic / Google / DeepSeek dashboard, with timestamps and token counts. You can revoke the key, rotate it, see exactly what it cost, and stop in one click.

### How this differs from other e-ink AI plugins

Most AI features on e-ink readers ship with a vendor-supplied key behind the scenes — the device maker (or a partner) holds the API account, your taps generate calls under their billing, and your prompts and replies pass through their pipeline. The UX is convenient, but you can't see the bill, can't audit what was sent, and can't switch providers. **Your data is on someone else's hands.**

Here the trade is reversed: you do the 30 seconds of setup once, and from then on every aspect of the LLM interaction — provider choice, model choice, billing, retention, deletion — is under your control.


## Demo 
### v1.0.1


https://github.com/user-attachments/assets/a176aae0-a33d-4885-a93f-0a7f63d1e861

### v1.0.2

https://github.com/user-attachments/assets/4b66eead-0561-4d46-afdd-21919ff1b5be

### v1.0.3

> _Demo recording placeholder — Grill Me on a PDF page + custom persona + custom quick actions._

## What's new in v1.0.3

- **Grill Me** — generate a 5-question multiple-choice drill deck from the current page of any PDF or EPUB. Active recall, not passive summarisation. See [Grill Me](#grill-me-active-recall-from-pdfepub).
- **Chat history (last 5)** — Copilot remembers your last five conversations across sessions. Tap the ⏱ icon in the chat header to flip between them or start a new one. Encrypted at rest when the vault is encrypted; plaintext alongside the keys otherwise.
- **Custom persona** — replace the default system prompt with your own. Drop a `system_prompt.txt` into `MyStyle/SnCopilot/`. See [Custom persona](#custom-persona-replace-the-system-prompt).
- **Custom quick actions** — add up to six of your own tappable action cards (e.g. "Glossary", "Risks", "Translate"). Drop a `custom_actions.txt` into `MyStyle/SnCopilot/`. See [Custom quick actions](#custom-quick-actions).
- **GPT-5 / o-series compatibility** — OpenAI now sends `max_completion_tokens` for `gpt-5*` and `o1*`/`o3*`/`o4*` reasoning models (which reject the legacy `max_tokens` field). `gpt-4o`, `gpt-4-turbo` etc. keep `max_tokens` as before.

## Quick start

1. **Pick a provider** and grab a key from their console. We ship templates for four:
   - [Anthropic Claude](https://console.anthropic.com/) — `templates/copilot-key-anthropic.txt`
   - [OpenAI](https://platform.openai.com/api-keys) — `templates/copilot-key-openai.txt`
   - [Google Gemini](https://aistudio.google.com/app/apikey) — `templates/copilot-key-gemini.txt`
   - [DeepSeek](https://platform.deepseek.com/api_keys) — `templates/copilot-key-deepseek.txt` *(text-only; the page image is not sent)*

2. **Create the directory on your Supernote** and copy the template:

   ```text
   /storage/emulated/0/MyStyle/
   └── SnCopilot/
       └── copilot-key-openai.txt    ← copy from templates/, edit, save
   ```

   USB sync, WebDAV, or Supernote Cloud all work — whichever you already use to move files.

3. **Edit the file** so the `key=` line carries your real key (and tweak `model=` if you want to). Example with OpenAI:

   ```text
   provider=openai
   model=gpt-4o-mini
   key=sk-proj-1345abCDef67890hijkLMNOpqrSTUvwxYZ012abc
   ```

4. **Tap the Copilot button** on the sidebar of any note, PDF, or EPUB. The popup opens; tap **Summary** to confirm everything works.

That's it. There is no account to create, no service to register against, no companion app on your phone.

## Default models in the templates

| Provider | Default model | Vision (page image) | Why this default |
|---|---|---|---|
| Anthropic | `claude-haiku-4-5` | yes | Cheapest Claude family with vision; fast on a single page. |
| OpenAI | `gpt-4o-mini` | yes | Cheapest GPT-4-class model with vision. |
| Google Gemini | `gemini-2.5-flash` | yes | Lowest-cost Gemini with vision; high context window. |
| DeepSeek | `deepseek-chat` | no — text only | Cheapest LLM available; fine for typed-text notes / extracted PDF text, no image support. |

You can change `model=` to any model the provider exposes — the plugin doesn't allow-list. If a model name is wrong the provider returns an HTTP error, which is shown verbatim in the chat as `Error: <provider>: HTTP <status>`.

> **OpenAI gpt-5 / o-series users:** the plugin auto-detects newer reasoning + GPT-5 family model ids (`gpt-5*`, `o1*`, `o3*`, `o4*`) and sends `max_completion_tokens` instead of the legacy `max_tokens` field that those models reject. You don't need to do anything — just put the model id in `model=` and it works.

## Grill Me — active recall from PDF/EPUB

Tap **Grill Me** on a PDF or EPUB page and Copilot generates a five-question multiple-choice deck from the page content. Each question has one correct answer and three near-miss distractors. You answer them one at a time on a single-surface card flow: stem + 4 choices → tap → reveal (verdict, explanation, source quote) → tap to advance.

The end screen breaks your performance down across four question types (cloze, definition, inference, application) on a 2×2 grid, and lists every card you missed with its source citation back into the page. A background quality pass scores the deck and silently regenerates weak cards before you see them — surveys (Quizlet, Khan, NotebookLM) confirmed learners care about retention, not model self-grading, so the rubric is backstage. **Grill again** rephrases the stems and reshuffles the choices so you can't pattern-match across repeats.

Only available on PDF / EPUB in v1 (handwritten `.note` files produce too-noisy OCR for high-quality stems). No setup — the button appears next to the four built-in actions on the empty-state suggestion grid whenever you open a PDF or EPUB.

## Custom persona — replace the system prompt

Copilot ships with a built-in system prompt tuned for note-taking. You can replace it wholesale by dropping a single text file:

**Path:** `/storage/emulated/0/MyStyle/SnCopilot/system_prompt.txt`

**Format:** no envelope, no key/value pairs — the **entire file content** is the persona. Up to 2000 characters; longer files are dropped at read time. Empty / whitespace-only file → Copilot uses the built-in prompt.

**How to add one:**

1. Create the file with USB / WebDAV / Supernote Cloud, *or* tap the ⚙ Settings cog → **Persona** → edit + Save (Settings writes the file for you).
2. Restart the overlay (close ×, reopen via sidebar) — the new persona is loaded on next open.

**Sample `system_prompt.txt`:**

```text
You are a writing coach helping a non-native English speaker
revise notes and short documents. When you summarise, prefer
plain words and short sentences. When you explain, give one
concrete example. Never use the words "essentially",
"basically", or "in essence". Reply in markdown.
```

Persona lives plaintext alongside the key files regardless of vault encryption — the user-managed file model is the deliberate choice so you can edit it externally with the same tools you use to manage the API key.

## Custom quick actions

Add up to **six** of your own tappable action cards to the empty-state suggestion grid, alongside the four built-ins (Summarize / Explain / Clarify / Snapshot) and Grill Me. Useful when you want a one-tap prompt that's specific to how *you* take notes.

**Path:** `/storage/emulated/0/MyStyle/SnCopilot/custom_actions.txt`

**Format:** one action per line as `label: prompt`. The first `:` is the separator; the prompt may contain more colons. Lines starting with `#` are comments; blank lines are skipped.

- `label` — under 16 characters, shown on the card.
- `prompt` — under 500 characters, the canned prompt sent to the LLM when the card is tapped.
- Hard cap of 6 actions per file; extras are ignored.

**How to add them:**

1. Create the file with USB / WebDAV / Supernote Cloud, *or* tap ⚙ Settings cog → **Custom actions** → edit + Save.
2. Reopen the chat panel — the new cards appear in the suggestion grid.

**Sample `custom_actions.txt`:**

```text
# Notes-assistant quick actions. Labels under 16 chars,
# prompts under 500 chars. Up to 6 entries.
Glossary: Define every technical term that appears on this page in two sentences each, in plain English.
Risks: List the risks implied by the content on this page, sorted by severity. One line per risk.
Translate: Translate the page content into French. Preserve any code blocks and equations verbatim.
Outline: Produce a hierarchical outline of this page — H1 for the main topic, H2 for sections, bullets for points.
Cite: List the cited works or external references on this page, with one-line summaries.
Counter: For each claim on this page, give one plausible counter-argument an expert reviewer might raise.
```

The plugin **reads** this file; CRUD lives in your text editor of choice, not in the app. The Settings → Custom actions screen shows a read-only preview so you can confirm the file parsed correctly.

## Chat history (last 5)

Copilot now remembers your **last five conversations** across sessions. Tap the ⏱ icon in the chat header to see the list, tap any entry to load it back into the chat, or tap ✎ to start a new one. FIFO eviction — when you start a sixth conversation, the oldest is dropped.

**Where it lives:**

- With **plaintext** encryption mode: a plain JSON file in the plugin's private install folder.
- With **encrypted** mode (PIN-protected vault): an encrypted envelope in the same folder, decrypted in memory only while the vault is unlocked.

Either way, history never leaves the device (it's part of the same on-device-only privacy posture as the keys themselves).

## Approximate cost per page summary

Rough cost of a single tap on **Summary** for an average page (≈1 image + ≈300 transcribed-text tokens in, ≈250 tokens out). Published rates are USD per 1M tokens and **change frequently** — confirm against the provider's pricing page before relying on these numbers.

| Model | Input rate | Output rate | Per-summary estimate |
|---|---|---|---|
| `claude-haiku-4-5` | $1.00 / 1M | $5.00 / 1M | ≈ $0.004 |
| `gpt-4o-mini` | $0.15 / 1M | $0.60 / 1M | ≈ $0.0007 |
| `gemini-2.5-flash` | $0.30 / 1M | $2.50 / 1M | ≈ $0.0015 |
| `deepseek-chat` (text only) | $0.27 / 1M | $1.10 / 1M | ≈ $0.0005 |

Rates as of 2026-05-09. Image tokens are larger than text tokens; a Supernote page screenshot at the default render size sits in the low thousands. In practice a heavy day of casual chat use is well under $0.10 across any of these models.

## Privacy posture in detail

The plugin sends two things to the configured provider on each chat send:

- **Your typed prompt** plus, when available, the **transcribed page text** (typed text from `.note` files or the document's text layer for PDFs / EPUBs).
- **The page screenshot**, except on DeepSeek where there is no vision endpoint.

There is no "PII redaction" toggle. On a vision-capable provider the page image carries everything that's visibly on the page, so scrubbing emails or numbers from the text payload while shipping the full screenshot would be theatre. On DeepSeek (text-only) the plugin silently scrubs emails and 7+ digit runs from the outbound text, since that's the one path where redaction actually reduces what we ship.

Be deliberate about which page is open before tapping Copilot. If the page contains something you wouldn't paste into a third-party chat box, don't tap.

### A note on shared filesystem access between plugins

The Supernote plugin runtime gives every installed plugin the same filesystem access the host app has — there is no per-plugin sandbox. By default your `copilot-key-<provider>.txt` lives as plaintext under `MyStyle/SnCopilot/`, where any other plugin you install can read it. Whether that matters depends on what other plugins you trust on the device.

Two mitigations, in increasing strength:

1. **Provider-side spend cap (always do this).** On the Anthropic / OpenAI / Google / DeepSeek dashboard, set a low monthly budget on the API key Copilot uses. A stolen key is then annoying instead of expensive. Use a *dedicated* key for Copilot that has no other entitlements.
2. **Encrypt the key with a PIN (opt-in).** See the section below.

## Optional: encrypt your key with a PIN

If you'd rather not leave the key sitting plaintext in shared storage, Copilot can encrypt it with a PIN you choose:

1. Drop your `copilot-key-<provider>.txt` into `MyStyle/SnCopilot/` as usual.
2. Open Copilot → tap the ⚙ Settings cog. The top of Settings will show a one-time **"Protect your API key"** prompt offering three buttons:
   - **Encrypt with a PIN  (recommended)** — choose a 6–12 digit PIN (or a passphrase ≥ 12 chars). Copilot writes an encrypted vault to its private install folder, then asks if you want to delete the plaintext `.txt`. After that, every time you open Copilot you'll be asked to enter the PIN once.
   - **Keep plaintext file** — today's behaviour. The key stays plaintext in shared storage.
   - **Decide later** — defer; we'll ask again next time you open Settings.
3. Once encrypted, the **Key encryption** section in Settings gives you:
   - **Lock now** — wipes the in-memory key without exiting.
   - **Change PIN** — re-encrypt with a new PIN.
   - **Disable encryption** — write the key back to plaintext (asks twice; this is destructive to the encryption posture).
   - **Reset key** — forgot the PIN? Delete the vault and start over with a fresh `.txt` drop.
   - **Auto-lock after** — pick how long inactivity has to last before the key is wiped from memory (default 10 min).

   **Forgot your PIN at the unlock screen?** Settings is hidden while the vault is locked (by design — there's nothing actionable in there until you're in). Type a wrong PIN 5 times in a row on the unlock screen and a **"Forgot PIN — reset Copilot key"** button appears. Tap it to delete the vault and return to the setup checklist; you'll then drop a fresh `copilot-key-<provider>.txt` to start over.

What this defends against, what it doesn't:

- ✓ Another co-installed Supernote plugin reading your key file. They get ciphertext.
- ✓ Casual access from anyone with USB / Supernote Cloud sync after the migration — the on-disk file is encrypted.
- ✗ Someone with USB or ADB access to your *unlocked* device while Copilot is unlocked. They can pull the encrypted file and watch you type.
- ✗ A weak PIN against an attacker who has exfiltrated the encrypted file and runs offline brute-force. PBKDF2 raises the per-attempt cost but won't save a 6-digit PIN against a determined adversary.
- ✗ Anything bad happening to the key in transit to your provider — that's still the provider's call to make.

In short: combine "encrypt with PIN" with "low spend cap on a dedicated key" for the strongest practical posture this plugin can give you.

## Building

Node.js 20+ required.

```sh
npm install
./buildPlugin.sh         # macOS / Linux
# or
powershell -ExecutionPolicy Bypass -File .\buildPlugin.ps1   # Windows
```

Both scripts produce `build/outputs/SnCopilot.snplg` from the same logical pipeline.

## Installing on the device

1. Build the plugin (above) or download `SnCopilot.snplg` from the [latest release](https://github.com/jrlabs01/sn-copilot/releases).
2. Copy `build/outputs/SnCopilot.snplg` into the `MyStyles` folder on your Supernote (Partner App, USB, or Supernote Cloud).
3. On the device: **Settings → Apps → Plugins → Add Plugin** and select the file.
4. The plugin appears as **Copilot** (or 助手 / コパイロット depending on locale) in the sidebar of any note, PDF, or EPUB.

## Running tests

```sh
npm test            # run unit suite
npm run coverage    # run with coverage report
npm run lint
```

The Jest config enforces a 97% threshold on statements / branches / functions / lines globally. Current measured coverage sits at ~99% statements / 98% branches.

## License

MIT — see [LICENSE](./LICENSE).

---

Issues and feature requests welcome — open one at the [issue tracker](https://github.com/jrlabs01/sn-copilot/issues).
