// Discovery + parsing for `copilot-key-<provider>.txt` files under
// `/storage/emulated/0/MyStyle/SnCopilot/`.
//
// One file per provider (anthropic|openai|gemini|deepseek). The user
// drops these in via USB or any cloud-sync provider and edits in
// place. The plugin never writes to them.
//
// Failures are isolated per file — one bad file does not block other
// valid files from being recognised. The parser tolerates common
// editor quirks (trailing whitespace, tabs, CRLF, blank lines,
// comments).

import {PROVIDER_IDS, type KeyFile, type Mode, type ProviderId} from '../types';
import {decodeUtf8} from '../sdk/utf8';
import type {Logger} from '../sdk/types';

export const DEFAULT_KEY_ROOT = '/storage/emulated/0/MyStyle/SnCopilot';

const TAG = '[keyFiles]';

// IMPORTANT: sn-plugin-lib's TypeScript declaration for listFiles
// claims `Promise<Array<string>>`, but the actual native
// implementation resolves with `Array<{path: string, type: 0|1}>`
// (0 = directory, 1 = file). The TS declaration is wrong; trusting
// it triggered a silent TypeError in our filter callback when
// callers passed FileUtils directly.
export type FileEntry = {path: string; type: number};

export type FileUtilsLike = {
  exists: (path: string) => Promise<boolean>;
  listFiles: (path: string) => Promise<FileEntry[] | null | undefined>;
};

export type DiscoveryDeps = {
  fileUtils: FileUtilsLike;
  rootPath?: string;
  // Defaults to globalThis.fetch. The host's RN polyfill handles
  // file:// URLs.
  fetchFn?: typeof fetch;
  logger?: Logger;
};

// Filename suffix → ProviderId, with tolerance for common variants.
// All keys are lowercased for the lookup — the matcher
// case-folds the actual filename.
//
//   anthropic / claude / claude-ai / claude-anthropic → anthropic
//   openai    / gpt    / chatgpt                       → openai
//   gemini    / google / google-gemini                 → gemini
//   deepseek                                            → deepseek
//
// The in-file `provider=` line still cross-checks against the
// CANONICAL id (so a `copilot-key-claude.txt` must contain
// `provider=anthropic`, not `provider=claude` — defensive against
// users renaming a file and forgetting to update its content).
const FILENAME_SUFFIX_MAP: Record<string, ProviderId> = {
  anthropic: 'anthropic',
  claude: 'anthropic',
  'claude-ai': 'anthropic',
  'claude-anthropic': 'anthropic',
  openai: 'openai',
  gpt: 'openai',
  chatgpt: 'openai',
  gemini: 'gemini',
  google: 'gemini',
  'google-gemini': 'gemini',
  deepseek: 'deepseek',
};

const FILENAME_RE = /^copilot-key-(.+)\.txt$/;

export const matchKeyFilename = (fileName: string): ProviderId | null => {
  const m = FILENAME_RE.exec(fileName.toLowerCase().trim());
  if (!m) {
    return null;
  }
  const suffix = m[1];
  return FILENAME_SUFFIX_MAP[suffix] ?? null;
};

export type ParseError = {
  kind: 'parse-error';
  path: string;
  reason: string;
};

export type ParseResult = {kind: 'ok'; file: KeyFile} | ParseError;

const baseName = (path: string): string =>
  path.slice(path.lastIndexOf('/') + 1);

const splitKeyValue = (line: string): [string, string] | null => {
  const eq = line.indexOf('=');
  if (eq < 0) {
    return null;
  }
  return [line.slice(0, eq).trim(), line.slice(eq + 1).trim()];
};

// Parse the raw text of one key file. Returns either a typed KeyFile
// or a ParseError describing the first fatal problem. Soft issues
// (unknown keys, invalid mode value, duplicate keys) log a warning
// and continue.
export const parseKeyFile = (
  text: string,
  path: string,
  logger: Logger,
): ParseResult => {
  const fileName = baseName(path);
  const expectedProvider = matchKeyFilename(fileName);
  if (!expectedProvider) {
    return {
      kind: 'parse-error',
      path,
      reason: `filename "${fileName}" is not a recognised key file`,
    };
  }

  const fields: Record<string, string> = {};
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const kv = splitKeyValue(line);
    if (!kv) {
      logger.log(`${TAG} ${fileName}: ignored malformed line: ${line}`);
      continue;
    }
    const [key, value] = kv;
    if (key.length === 0) {
      logger.log(`${TAG} ${fileName}: ignored line with empty key`);
      continue;
    }
    if (key in fields) {
      logger.warn(
        `${TAG} ${fileName}: duplicate key "${key}" — last value wins`,
      );
    }
    fields[key] = value;
  }

  const provider = fields.provider as ProviderId | undefined;
  if (!provider) {
    return {kind: 'parse-error', path, reason: 'missing required field: provider'};
  }
  if (provider !== expectedProvider) {
    return {
      kind: 'parse-error',
      path,
      reason:
        `provider="${provider}" mismatches filename suffix ` +
        `(expected canonical "${expectedProvider}")`,
    };
  }
  if (!fields.key || fields.key.length === 0) {
    return {kind: 'parse-error', path, reason: 'missing required field: key'};
  }
  if (!fields.model || fields.model.length === 0) {
    return {kind: 'parse-error', path, reason: 'missing required field: model'};
  }

  // Default mode follows the provider's vision capability:
  // anthropic / openai / gemini are image-capable, so handwritten
  // Notes (which carry their content in the page image, not a text
  // layer) work out of the box. DeepSeek is text-only — its default
  // stays 'text'. Explicit mode= in the key file always wins.
  const defaultMode: Mode = provider === 'deepseek' ? 'text' : 'image';
  let mode: Mode = defaultMode;
  if (fields.mode !== undefined) {
    if (fields.mode === 'text' || fields.mode === 'image') {
      mode = fields.mode;
    } else {
      logger.warn(
        `${TAG} ${fileName}: invalid mode="${fields.mode}" — defaulting to ${defaultMode}`,
      );
    }
  }

  let defaultProvider: ProviderId | undefined;
  if (fields.default_provider !== undefined) {
    if (PROVIDER_IDS.includes(fields.default_provider as ProviderId)) {
      defaultProvider = fields.default_provider as ProviderId;
    } else {
      logger.warn(
        `${TAG} ${fileName}: invalid default_provider="${fields.default_provider}" — ignored`,
      );
    }
  }

  let clarifyRedact: boolean | undefined;
  if (fields.clarify_redact !== undefined) {
    if (fields.clarify_redact === 'on' || fields.clarify_redact === 'true') {
      clarifyRedact = true;
    } else if (
      fields.clarify_redact === 'off' ||
      fields.clarify_redact === 'false'
    ) {
      clarifyRedact = false;
    } else {
      logger.warn(
        `${TAG} ${fileName}: invalid clarify_redact="${fields.clarify_redact}" — ignored`,
      );
    }
  }

  for (const k of Object.keys(fields)) {
    if (
      k !== 'provider' &&
      k !== 'model' &&
      k !== 'key' &&
      k !== 'mode' &&
      k !== 'default_provider' &&
      k !== 'clarify_redact'
    ) {
      logger.log(`${TAG} ${fileName}: ignored unknown key "${k}"`);
    }
  }

  return {
    kind: 'ok',
    file: {
      provider: expectedProvider,
      model: fields.model,
      key: fields.key,
      mode,
      defaultProvider,
      clarifyRedact,
      sourcePath: path,
    },
  };
};

// Find every copilot-key-*.txt under root, parse each, and return
// the successful KeyFile entries plus any parse errors.
//
// Pipeline: listFiles → filter by type === 1 → fetch('file://...')
// → arrayBuffer → decodeUtf8 → parse.
export const discoverKeyFiles = async (
  deps: DiscoveryDeps,
): Promise<{files: KeyFile[]; errors: ParseError[]}> => {
  const root = deps.rootPath ?? DEFAULT_KEY_ROOT;
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const noop = (): void => {};
  const logger: Logger = deps.logger ?? {log: noop, warn: noop, error: noop};

  let entries: FileEntry[] | null | undefined;
  try {
    entries = await deps.fileUtils.listFiles(root);
  } catch (e) {
    logger.log(
      `${TAG} root "${root}" not listable (${(e as Error).message}) — no key files`,
    );
    return {files: [], errors: []};
  }
  if (!entries || entries.length === 0) {
    logger.log(`${TAG} root "${root}" empty — no key files`);
    return {files: [], errors: []};
  }

  // type === 1 is "file"; reject directories and any entry that
  // does not match the copilot-key-*.txt pattern.
  const candidates = entries.filter(
    e => e.type === 1 && matchKeyFilename(baseName(e.path)) !== null,
  );

  logger.log(
    `${TAG} root "${root}" found ${entries.length} entries, ${candidates.length} candidate(s)`,
  );

  const files: KeyFile[] = [];
  const errors: ParseError[] = [];

  for (const entry of candidates) {
    try {
      const res = await fetchFn(`file://${entry.path}`);
      if (!res.ok) {
        errors.push({
          kind: 'parse-error',
          path: entry.path,
          reason: `fetch returned status ${res.status}`,
        });
        continue;
      }
      const buf = await res.arrayBuffer();
      const text = decodeUtf8(new Uint8Array(buf));
      const parsed = parseKeyFile(text, entry.path, logger);
      if (parsed.kind === 'ok') {
        files.push(parsed.file);
      } else {
        errors.push(parsed);
      }
    } catch (e) {
      errors.push({
        kind: 'parse-error',
        path: entry.path,
        reason: `read threw: ${(e as Error).message}`,
      });
    }
  }

  return {files, errors};
};
