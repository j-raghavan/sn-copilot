# Copilot Plugin for Supernote

![Tests](https://img.shields.io/badge/tests-351%20passed-brightgreen)
![Coverage](https://img.shields.io/badge/coverage-99%25%20lines%20%2F%2098%25%20branches-brightgreen)
![Lint](https://img.shields.io/badge/lint-passing-brightgreen)
![Platform](https://img.shields.io/badge/platform-Supernote-blue)
![License](https://img.shields.io/badge/license-MIT-blue)
![Version](https://img.shields.io/badge/version-1.0.2-blue)

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
