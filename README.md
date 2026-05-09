# Copilot Plugin for Supernote

![Tests](https://img.shields.io/badge/tests-351%20passed-brightgreen)
![Coverage](https://img.shields.io/badge/coverage-99%25%20lines%20%2F%2098%25%20branches-brightgreen)
![Lint](https://img.shields.io/badge/lint-passing-brightgreen)
![Platform](https://img.shields.io/badge/platform-Supernote-blue)
![License](https://img.shields.io/badge/license-MIT-blue)
![Version](https://img.shields.io/badge/version-0.1.0-blue)

An on-device AI chat sidebar for Supernote notes, PDFs, and EPUBs. Tap the **Copilot** button on the sidebar, ask the model to summarise the page, explain a section, or answer a question — the page screenshot and any extracted text go to the LLM you configured, and the reply lands in a panel on the right edge of the screen.

## Privacy is yours, not ours

This plugin has **no backend**. It does not run a service, route your traffic through anyone's server, or hold a key on your behalf. You bring your own API key for Anthropic, OpenAI, Google Gemini, or DeepSeek; the plugin places your request directly against that provider's API and shows the response.

**What that means concretely:**

- **You own the key.** It lives in a text file in `MyStyle/SnCopilot/` on your device — created by you, never uploaded by us, never copied off the device by the plugin.
- **You own the conversation.** Requests go from your device to the provider you chose. We never see them. There is no "Copilot history" stored anywhere outside your provider's account.
- **You own the audit.** Every billable request shows up on **your** OpenAI / Anthropic / Google / DeepSeek dashboard, with timestamps and token counts. You can revoke the key, rotate it, see exactly what it cost, and stop in one click.

### How this differs from other e-ink AI plugins

Most AI features on e-ink readers ship with a vendor-supplied key behind the scenes — the device maker (or a partner) holds the API account, your taps generate calls under their billing, and your prompts and replies pass through their pipeline. The UX is convenient, but you can't see the bill, can't audit what was sent, and can't switch providers. **Your data is on someone else's hands.**

Here the trade is reversed: you do the 30 seconds of setup once, and from then on every aspect of the LLM interaction — provider choice, model choice, billing, retention, deletion — is under your control.


## Demo 
### v1.0.1


https://github.com/user-attachments/assets/a176aae0-a33d-4885-a93f-0a7f63d1e861



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
