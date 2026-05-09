# Repository instructions for GitHub Copilot

You are reviewing code for an open source project.

## Review priorities
Focus on:
- correctness and edge cases
- security issues and unsafe defaults (especially around API keys, key files, and provider responses)
- backward compatibility
- performance regressions in hot paths
- unnecessary complexity
- missing tests for changed behavior
- API and schema stability
- maintainability and readability

## What to avoid
Do not suggest:
- large refactors unless clearly necessary
- stylistic churn without concrete benefit
- adding dependencies unless justified
- speculative changes not grounded in the diff

## Project expectations
Prefer:
- small targeted fixes
- explicit error handling
- clear naming
- simple designs over clever abstractions
- preserving existing public behavior unless the PR explicitly changes it

## Testing expectations
Flag when:
- behavior changes without tests
- edge cases are untested
- error paths are untested
- docs should be updated because user-facing behavior changed

## Review style
Be concise and specific.
Reference the exact risk and the likely impact.
When possible, suggest a minimal fix.

---

## Engineering principles

This project enforces a principal-engineer quality bar. Apply these consistently when reviewing.

### SOLID
- **Single Responsibility** — every module / component / function should have one clear reason to change. Flag handlers that grow side concerns (logging policy, state persistence, UI decisions) into the same unit.
- **Open / Closed** — prefer extension via new modules, configuration, or strategy injection over editing core logic. New providers should plug in via the `ProviderClient` interface, not by adding branches inside `runAction`.
- **Liskov Substitution** — when a function takes a `*Like` interface (the project's DI pattern, e.g. `FileUtilsLike`), every implementation must honour the contract. Flag mocks or test doubles that diverge in observable behavior from production callers.
- **Interface Segregation** — narrow `*Like` interfaces to the methods the consumer actually calls. Flag deps objects that pull in API surface the handler never invokes.
- **Dependency Inversion** — handlers, the action runner, and the UI all depend on abstractions (interfaces / dep objects), not on concrete `sn-plugin-lib` symbols. Flag direct turbomodule imports inside handler / pure modules — those belong only in `index.js`.

### KISS
- Pick the simplest design that satisfies the requirement.
- A 30-line handler with one clear branch is better than a 10-line handler that needs a comment to explain.
- Flag clever one-liners, dynamic dispatch, or meta-programming when a straightforward function suffices.

### DRY
- Extract a helper when the same logic appears 3+ times *and* the abstraction names the concept naturally. Two near-duplicates are usually fine; three is the rule-of-three threshold.
- Flag copy-pasted SDK call sequences, copy-pasted try/catch blocks around the same fallback, and copy-pasted log prefixes.
- Reuse existing helpers (`unwrap`, `safeClosePluginView`, `decodeBase64`, `decodeUtf8`) rather than re-rolling them inline.

### DDD-flavored boundaries
The codebase follows clear ubiquitous-language boundaries — keep them.
- `src/buttons/` — registration with the firmware.
- `src/handlers/` — entry-gesture pipelines (orchestration only; no SDK turbomodule imports, no React).
- `src/scope/` — page-payload resolvers (NOTE / DOC, text / image). Pure data extraction; no provider knowledge.
- `src/redact/` — PII rules and forward/reverse redaction. Pure functions, no SDK.
- `src/providers/` — per-provider HTTPS clients behind a uniform `ProviderClient` interface. No UI, no scope, no redaction.
- `src/actions/` — the four action prompts and `runAction` orchestrator. Pulls scope → redact → provider → un-redact in order.
- `src/insert/` — Insert path (TextBox + userData) and clipboard helpers. NOTE-only writes; DOC scope must not reach here.
- `src/storage/` — key-file discovery, parsing, and `default_provider` resolution. No SDK calls beyond `FileUtils`-shaped IO.
- `src/sdk/` — narrow utilities that bridge platform quirks (`utf8`, `base64`, `apiResponse`, `closeView`, `types`).
- `src/i18n/` — locale resolution and string tables.
- `src/ui/` — React Native components.

Flag changes that **leak across these boundaries** — e.g. a handler reaching into a provider client directly, a redaction module importing React, a button-registration module pulling in provider types.

---

## Plugin-specific gotchas (do not regress)

These bit me on-device or in code review and are documented in PR notes / commit messages. Flag any change that breaks them.

### Reentrancy guard must clear synchronously before any await
`src/reentrancy/inFlightGuard.ts` is module-level. Handlers must call `release()` **before** awaiting `closePluginView` in the `finally` block. Clearing it after the await leaves the flag stuck `true` if the host's `state:stop` transition suspends the JS context — every subsequent button press is then rejected as busy.

### setSystemDormancyState must be paired
Every provider call wraps `setSystemDormancyState(true)` on entry and `setSystemDormancyState(false)` in a `finally`. Without the finally, a thrown response leaves the device unable to sleep. Flag any new long-running call path that omits the pairing.

### `editDataTypes` is firmware-filter sensitive
sn-copilot v1 ships with a single sidebar button (`type=1`) — no `editDataTypes` involved. If a future PR adds a lasso button (`type=2`), the firmware filters lasso buttons more strictly than the SDK doc suggests: `editDataTypes` must be all stroke-family or all text-family; mixing hides the button on every lasso. Empirical evidence is captured in v0.4 §6.3 of the requirements doc.

### `console.warn` and `console.error` are NOT reliably visible in on-device logcat
Every `ReactNativeJS:` line on the Supernote firmware lands at info level. The logger in `index.js` routes every level through `console.log` with `[WARN]` / `[ERROR]` prefixes so diagnostics are visible. Flag any PR that:
- Reverts the logger to use `console.warn` / `console.error` directly.
- Drops the startup key-file scan probe — that's how a missing or invalid key file surfaces in logcat without waiting for first user action.

### Platform globals must be polyfilled defensively
`TextEncoder` / `TextDecoder` / `atob` are unreliable on the Supernote JS engine — they may be undefined, throw on construction, or return malformed values. `src/sdk/utf8.ts` and `src/sdk/base64.ts` try the platform globals first then fall back to portable inline implementations. Flag any PR that:
- Uses `new TextEncoder()` / `new TextDecoder()` / `atob()` directly in `src/`. Use `encodeUtf8` / `decodeUtf8` / `decodeBase64` instead.
- Removes the fallback paths.

### API keys never leave the provider call stack
Keys live on disk in `MyStyle/SnCopilot/copilot-key-*.txt` and in process memory only inside the `ProviderClient.send` call frame. Flag any PR that:
- Stores a key on React state, in `AsyncStorage`, or in any other persistent or globally-scoped value.
- Logs a header containing `Authorization` / `x-api-key`, or a query param named `key`.
- Echoes a key into an error message or stack trace.

### Image mode does not redact
`mode=image` sends the raster as-is. PII redaction (`src/redact/`) is wired only for `mode=text`. Flag any PR that:
- Adds opaque "redaction" to the image path that doesn't actually mask pixels (false advertising).
- Sends a redacted text alongside an unredacted image (defeats the purpose of redaction).

### Insert is NOTE-only
`PluginFileAPI.insertElements` is the only Insert path; it is not callable for DOC/PDF/EPUB containers, and modifying source PDFs is hostile UX besides. The result panel hides the Insert button in DOC scopes. Flag any PR that:
- Wires Insert in a DOC handler.
- Removes the scope-kind branch on the result panel.

### License: project is MIT, runtime deps must stay permissive
sn-copilot's runtime deps (`react`, `react-native`, `sn-plugin-lib`, `@react-native-clipboard/clipboard`) are all permissive. Flag any PR that:
- Adds a runtime dependency without checking its license.
- Adds a GPL / AGPL / LGPL runtime dependency.

---

## Coverage and lint policy

- `jest.config.js` enforces **97% global coverage** on statements / branches / functions / lines.
- Pure-types files (`src/types.ts`, `src/sdk/types.ts`) are excluded from coverage; flag PRs that exclude additional files without justifying it.
- Lint must be clean (`npm run lint`). The `@react-native/eslint-config` ruleset includes `no-bitwise`; bitwise ops in the UTF-8 / base64 code are bracketed by `/* eslint-disable no-bitwise */` — flag broad disables that aren't scoped.
- `npx tsc --noEmit` must be clean.

## Build and CI

- `buildPlugin.sh` (macOS/Linux) and `buildPlugin.ps1` (Windows) are the two parallel entry points; both run the same logical pipeline and must stay in lockstep. Flag PRs that bypass them (e.g. `npx react-native bundle` directly) or that update one script without updating the other.
- `.github/workflows/release.yml` rewrites `package.json` and `PluginConfig.json` versions on the runner. Flag PRs that hand-edit those version fields outside a release.

## Commit and PR hygiene
- Commit messages are first-person singular and never attribute Claude or any AI assistant.
- Specific files / line numbers go in commit bodies, not PR descriptions.
- PR descriptions follow `## Summary`, `## Test plan`, `## Verified locally` headings.
- Force-pushes to `master` are forbidden. Force-pushes to feature branches require explicit approval.
