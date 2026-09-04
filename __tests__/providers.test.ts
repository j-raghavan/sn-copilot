/**
 * Tests for the four real provider clients + their shared
 * HTTP error helper + the registry index. Wire-level shape pins:
 *
 *   - Endpoint URL, method, headers, body shape per provider.
 *   - Auth strategy: anthropic uses x-api-key + version header;
 *     openai/deepseek use Authorization: Bearer; gemini puts the
 *     key in the URL query.
 *   - Response decoding: anthropic concatenates content[].text blocks;
 *     openai/deepseek read choices[0].message.content; gemini joins
 *     candidates[0].content.parts.text.
 *   - Token usage shape per provider.
 *   - 4xx/5xx: throwHttpError formats `provider: HTTP <status> — <body>`,
 *     and falls back gracefully if .text() throws.
 *   - Factory createProviderClient routes by id.
 */
import {createAnthropicClient} from '../src/providers/anthropic';
import {
  createOpenAIClient,
  usesMaxCompletionTokens,
} from '../src/providers/openai';
import {createGeminiClient} from '../src/providers/gemini';
import {createDeepSeekClient} from '../src/providers/deepseek';
import {createProviderClient} from '../src/providers/index';
import {throwHttpError} from '../src/providers/_http';

type FetchSpy = jest.Mock<Promise<Response>, [string, RequestInit]>;

const buildOk = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response);

const buildErr = (status: number, body: string | (() => Promise<string>)): Response =>
  ({
    ok: false,
    status,
    json: async () => ({}),
    text: typeof body === 'function' ? body : async () => body,
  } as unknown as Response);

const baseReq = () => ({
  systemPrompt: 'You are a helpful assistant.',
  userText: 'Hello',
  maxTokens: 64,
  signal: new AbortController().signal,
});

describe('throwHttpError', () => {
  it('formats body when text() succeeds', async () => {
    await expect(
      throwHttpError('anthropic', buildErr(401, 'auth failed')),
    ).rejects.toThrow('anthropic: HTTP 401 — auth failed');
  });

  it('omits dash when body is empty', async () => {
    await expect(
      throwHttpError('openai', buildErr(503, '')),
    ).rejects.toThrow('openai: HTTP 503');
  });

  it('falls back to bare status when text() throws', async () => {
    await expect(
      throwHttpError(
        'gemini',
        buildErr(500, async () => {
          throw new Error('body unreadable');
        }),
      ),
    ).rejects.toThrow('gemini: HTTP 500');
  });
});

describe('createAnthropicClient', () => {
  it('POSTs to /v1/messages with x-api-key + anthropic-version', async () => {
    const fetchFn: FetchSpy = jest.fn().mockResolvedValue(
      buildOk({
        content: [
          {type: 'text', text: 'Hi '},
          {type: 'tool_use'},
          {type: 'text', text: 'there.'},
        ],
        usage: {input_tokens: 12, output_tokens: 7},
        model: 'claude-haiku-4-5-real',
      }),
    );
    const client = createAnthropicClient(fetchFn as unknown as typeof fetch);
    const r = await client.send(baseReq(), {
      apiKey: 'sk-ant-x',
      model: 'claude-haiku-4-5',
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      'x-api-key': 'sk-ant-x',
      'anthropic-version': '2023-06-01',
    });
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('claude-haiku-4-5');
    expect(body.max_tokens).toBe(64);
    expect(body.system).toContain('helpful');
    expect(body.messages[0]).toEqual({
      role: 'user',
      content: [{type: 'text', text: 'Hello'}],
    });

    expect(r.text).toBe('Hi there.');
    expect(r.usage).toEqual({
      inputTokens: 12,
      outputTokens: 7,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    expect(r.modelId).toBe('claude-haiku-4-5-real');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(client.id).toBe('anthropic');
  });

  it('returns empty string when content[] is missing', async () => {
    const fetchFn: FetchSpy = jest.fn().mockResolvedValue(buildOk({}));
    const client = createAnthropicClient(fetchFn as unknown as typeof fetch);
    const r = await client.send(baseReq(), {apiKey: 'k', model: 'm'});
    expect(r.text).toBe('');
    expect(r.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    // Falls back to opts.model when response carries no model
    expect(r.modelId).toBe('m');
  });

  it('throws formatted HTTP error on non-ok response', async () => {
    const fetchFn: FetchSpy = jest
      .fn()
      .mockResolvedValue(buildErr(403, 'forbidden'));
    const client = createAnthropicClient(fetchFn as unknown as typeof fetch);
    await expect(
      client.send(baseReq(), {apiKey: 'k', model: 'm'}),
    ).rejects.toThrow('anthropic: HTTP 403 — forbidden');
  });

  it('uses globalThis.fetch when no fetchFn is supplied', () => {
    const client = createAnthropicClient();
    expect(client.id).toBe('anthropic');
  });
});

describe('createOpenAIClient', () => {
  it('POSTs to /chat/completions with Bearer auth', async () => {
    const fetchFn: FetchSpy = jest.fn().mockResolvedValue(
      buildOk({
        choices: [{message: {content: 'hi from gpt'}}],
        usage: {prompt_tokens: 5, completion_tokens: 8},
        model: 'gpt-resolved',
      }),
    );
    const client = createOpenAIClient(fetchFn as unknown as typeof fetch);
    const r = await client.send(baseReq(), {
      apiKey: 'sk-openai',
      model: 'gpt-4o-mini',
    });

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer sk-openai',
      'content-type': 'application/json',
    });
    const body = JSON.parse(init.body as string);
    expect(body.messages[0]).toEqual({
      role: 'system',
      content: 'You are a helpful assistant.',
    });
    expect(body.messages[1]).toEqual({role: 'user', content: 'Hello'});

    expect(r.text).toBe('hi from gpt');
    expect(r.usage).toEqual({inputTokens: 5, outputTokens: 8});
    expect(r.modelId).toBe('gpt-resolved');
    expect(client.id).toBe('openai');
  });

  it('returns empty string when choices[] is empty', async () => {
    const fetchFn: FetchSpy = jest
      .fn()
      .mockResolvedValue(buildOk({choices: []}));
    const client = createOpenAIClient(fetchFn as unknown as typeof fetch);
    const r = await client.send(baseReq(), {apiKey: 'k', model: 'm'});
    expect(r.text).toBe('');
    expect(r.usage).toEqual({inputTokens: 0, outputTokens: 0});
    expect(r.modelId).toBe('m');
  });

  it('throws formatted HTTP error on non-ok', async () => {
    const fetchFn: FetchSpy = jest
      .fn()
      .mockResolvedValue(buildErr(429, 'rate limit'));
    const client = createOpenAIClient(fetchFn as unknown as typeof fetch);
    await expect(
      client.send(baseReq(), {apiKey: 'k', model: 'm'}),
    ).rejects.toThrow('openai: HTTP 429 — rate limit');
  });

  it('uses globalThis.fetch when no fetchFn supplied', () => {
    expect(createOpenAIClient().id).toBe('openai');
  });

  describe('token-cap parameter switch (gpt-5 / o-series)', () => {
    // gpt-5 family and reasoning models (o1*/o3*/o4*) reject
    // max_tokens with a 400; legacy models (gpt-4o*, gpt-4-turbo) only
    // accept max_tokens. Pick per request.
    const send = async (
      model: string,
    ): Promise<{[k: string]: unknown}> => {
      const fetchFn: FetchSpy = jest.fn().mockResolvedValue(
        buildOk({choices: [{message: {content: 'ok'}}]}),
      );
      const client = createOpenAIClient(fetchFn as unknown as typeof fetch);
      await client.send(baseReq(), {apiKey: 'k', model});
      return JSON.parse(fetchFn.mock.calls[0][1].body as string);
    };

    it('legacy models (gpt-4o-mini) keep max_tokens, no max_completion_tokens', async () => {
      const body = await send('gpt-4o-mini');
      expect(body.max_tokens).toBe(64);
      expect(body.max_completion_tokens).toBeUndefined();
    });

    it('legacy gpt-4-turbo keeps max_tokens', async () => {
      const body = await send('gpt-4-turbo');
      expect(body.max_tokens).toBe(64);
      expect(body.max_completion_tokens).toBeUndefined();
    });

    it('gpt-5 sends max_completion_tokens, no max_tokens', async () => {
      const body = await send('gpt-5');
      expect(body.max_completion_tokens).toBe(64);
      expect(body.max_tokens).toBeUndefined();
    });

    it('gpt-5-mini sends max_completion_tokens', async () => {
      const body = await send('gpt-5-mini');
      expect(body.max_completion_tokens).toBe(64);
      expect(body.max_tokens).toBeUndefined();
    });

    it('o1-mini sends max_completion_tokens (reasoning family)', async () => {
      const body = await send('o1-mini');
      expect(body.max_completion_tokens).toBe(64);
      expect(body.max_tokens).toBeUndefined();
    });

    it('o3-mini sends max_completion_tokens', async () => {
      const body = await send('o3-mini');
      expect(body.max_completion_tokens).toBe(64);
      expect(body.max_tokens).toBeUndefined();
    });

    it('classifier: usesMaxCompletionTokens', () => {
      expect(usesMaxCompletionTokens('gpt-4o-mini')).toBe(false);
      expect(usesMaxCompletionTokens('gpt-4-turbo')).toBe(false);
      expect(usesMaxCompletionTokens('gpt-3.5-turbo')).toBe(false);
      expect(usesMaxCompletionTokens('gpt-5')).toBe(true);
      expect(usesMaxCompletionTokens('gpt-5-mini')).toBe(true);
      expect(usesMaxCompletionTokens('gpt-5-nano')).toBe(true);
      expect(usesMaxCompletionTokens('GPT-5')).toBe(true);
      expect(usesMaxCompletionTokens('o1')).toBe(true);
      expect(usesMaxCompletionTokens('o1-mini')).toBe(true);
      expect(usesMaxCompletionTokens('o3-mini')).toBe(true);
      expect(usesMaxCompletionTokens('o4-mini')).toBe(true);
    });
  });
});

describe('createGeminiClient', () => {
  it('POSTs to ?key= URL with model in path', async () => {
    const fetchFn: FetchSpy = jest.fn().mockResolvedValue(
      buildOk({
        candidates: [
          {
            content: {
              parts: [{text: 'hello '}, {text: 'gemini'}],
            },
          },
        ],
        usageMetadata: {promptTokenCount: 11, candidatesTokenCount: 14},
        modelVersion: 'gemini-2-real',
      }),
    );
    const client = createGeminiClient(fetchFn as unknown as typeof fetch);
    const r = await client.send(baseReq(), {
      apiKey: 'goog-key&q', // intentionally URL-unsafe to test encoding
      model: 'gemini-2.0/flash',
    });

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain(
      '/v1beta/models/gemini-2.0%2Fflash:generateContent?key=goog-key%26q',
    );
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({'content-type': 'application/json'});
    // Gemini auth via URL — Authorization header MUST NOT be set
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    const body = JSON.parse(init.body as string);
    expect(body.systemInstruction.parts[0].text).toContain('helpful');
    expect(body.contents[0]).toEqual({
      role: 'user',
      parts: [{text: 'Hello'}],
    });
    expect(body.generationConfig).toEqual({maxOutputTokens: 64});

    expect(r.text).toBe('hello gemini');
    expect(r.usage).toEqual({inputTokens: 11, outputTokens: 14});
    expect(r.modelId).toBe('gemini-2-real');
    expect(client.id).toBe('gemini');
  });

  it('handles missing parts and fields gracefully', async () => {
    const fetchFn: FetchSpy = jest.fn().mockResolvedValue(buildOk({}));
    const client = createGeminiClient(fetchFn as unknown as typeof fetch);
    const r = await client.send(baseReq(), {apiKey: 'k', model: 'gemini-pro'});
    expect(r.text).toBe('');
    expect(r.usage).toEqual({inputTokens: 0, outputTokens: 0});
    expect(r.modelId).toBe('gemini-pro');
  });

  it('handles a candidate with no parts array', async () => {
    const fetchFn: FetchSpy = jest
      .fn()
      .mockResolvedValue(buildOk({candidates: [{content: {}}]}));
    const client = createGeminiClient(fetchFn as unknown as typeof fetch);
    const r = await client.send(baseReq(), {apiKey: 'k', model: 'm'});
    expect(r.text).toBe('');
  });

  it('handles parts entries with missing text', async () => {
    const fetchFn: FetchSpy = jest.fn().mockResolvedValue(
      buildOk({
        candidates: [{content: {parts: [{}, {text: 'only'}]}}],
      }),
    );
    const client = createGeminiClient(fetchFn as unknown as typeof fetch);
    const r = await client.send(baseReq(), {apiKey: 'k', model: 'm'});
    expect(r.text).toBe('only');
  });

  it('throws formatted HTTP error on non-ok', async () => {
    const fetchFn: FetchSpy = jest
      .fn()
      .mockResolvedValue(buildErr(400, 'bad request'));
    const client = createGeminiClient(fetchFn as unknown as typeof fetch);
    await expect(
      client.send(baseReq(), {apiKey: 'k', model: 'm'}),
    ).rejects.toThrow('gemini: HTTP 400 — bad request');
  });

  it('uses globalThis.fetch when no fetchFn supplied', () => {
    expect(createGeminiClient().id).toBe('gemini');
  });
});

describe('createDeepSeekClient', () => {
  it('POSTs to deepseek.com/chat/completions with Bearer auth', async () => {
    const fetchFn: FetchSpy = jest.fn().mockResolvedValue(
      buildOk({
        choices: [{message: {content: 'reply from deepseek'}}],
        usage: {prompt_tokens: 4, completion_tokens: 9},
        model: 'deepseek-chat-real',
      }),
    );
    const client = createDeepSeekClient(fetchFn as unknown as typeof fetch);
    const r = await client.send(baseReq(), {
      apiKey: 'ds-key',
      model: 'deepseek-chat',
    });

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(init.headers).toMatchObject({Authorization: 'Bearer ds-key'});
    const body = JSON.parse(init.body as string);
    expect(body.messages).toEqual([
      {role: 'system', content: 'You are a helpful assistant.'},
      {role: 'user', content: 'Hello'},
    ]);

    expect(r.text).toBe('reply from deepseek');
    expect(r.usage).toEqual({inputTokens: 4, outputTokens: 9});
    expect(r.modelId).toBe('deepseek-chat-real');
    expect(client.id).toBe('deepseek');
  });

  it('returns empty string when choices is missing', async () => {
    const fetchFn: FetchSpy = jest.fn().mockResolvedValue(buildOk({}));
    const client = createDeepSeekClient(fetchFn as unknown as typeof fetch);
    const r = await client.send(baseReq(), {apiKey: 'k', model: 'm'});
    expect(r.text).toBe('');
    expect(r.modelId).toBe('m');
  });

  it('throws formatted HTTP error on non-ok', async () => {
    const fetchFn: FetchSpy = jest
      .fn()
      .mockResolvedValue(buildErr(502, 'upstream'));
    const client = createDeepSeekClient(fetchFn as unknown as typeof fetch);
    await expect(
      client.send(baseReq(), {apiKey: 'k', model: 'm'}),
    ).rejects.toThrow('deepseek: HTTP 502 — upstream');
  });

  it('uses globalThis.fetch when no fetchFn supplied', () => {
    expect(createDeepSeekClient().id).toBe('deepseek');
  });
});

describe('image attachment per provider', () => {
  const okJson = (body: unknown): Response =>
    ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response);

  it('Anthropic: prepends an image block to user content', async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      okJson({
        content: [{type: 'text', text: 'OK'}],
        usage: {input_tokens: 1, output_tokens: 1},
      }),
    );
    const client = createAnthropicClient(fetchFn as unknown as typeof fetch);
    await client.send(
      {...baseReq(), imageBase64: 'AAAA'},
      {apiKey: 'k', model: 'm'},
    );
    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string);
    expect(body.messages[0].content).toEqual([
      {
        type: 'image',
        source: {type: 'base64', media_type: 'image/png', data: 'AAAA'},
        // End of the stable prefix — see the prompt-caching describe.
        cache_control: {type: 'ephemeral'},
      },
      {type: 'text', text: 'Hello'},
    ]);
  });

  it('OpenAI: switches user content to typed parts when image present', async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      okJson({
        choices: [{message: {content: 'OK'}}],
        usage: {prompt_tokens: 1, completion_tokens: 1},
      }),
    );
    const client = createOpenAIClient(fetchFn as unknown as typeof fetch);
    await client.send(
      {...baseReq(), imageBase64: 'BBBB'},
      {apiKey: 'k', model: 'm'},
    );
    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string);
    expect(body.messages[1].content).toEqual([
      {
        type: 'image_url',
        image_url: {url: 'data:image/png;base64,BBBB'},
      },
      {type: 'text', text: 'Hello'},
    ]);
  });

  it('OpenAI: keeps user content as plain string when no image', async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      okJson({choices: [{message: {content: ''}}]}),
    );
    const client = createOpenAIClient(fetchFn as unknown as typeof fetch);
    await client.send(baseReq(), {apiKey: 'k', model: 'm'});
    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string);
    expect(body.messages[1].content).toBe('Hello');
  });

  it('Gemini: prepends inline_data part when image present', async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      okJson({
        candidates: [{content: {parts: [{text: 'OK'}]}}],
      }),
    );
    const client = createGeminiClient(fetchFn as unknown as typeof fetch);
    await client.send(
      {...baseReq(), imageBase64: 'CCCC'},
      {apiKey: 'k', model: 'm'},
    );
    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string);
    expect(body.contents[0].parts).toEqual([
      {inline_data: {mime_type: 'image/png', data: 'CCCC'}},
      {text: 'Hello'},
    ]);
  });

  it('DeepSeek: silently drops the image attachment (text-only)', async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      okJson({choices: [{message: {content: 'OK'}}]}),
    );
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const client = createDeepSeekClient(fetchFn as unknown as typeof fetch);
      await client.send(
        {...baseReq(), imageBase64: 'DDDD'},
        {apiKey: 'k', model: 'm'},
      );
      const body = JSON.parse(fetchFn.mock.calls[0][1].body as string);
      // No image_url part — content stays as a plain string
      expect(body.messages[1].content).toBe('Hello');
      expect(
        log.mock.calls.some(c =>
          c.join(' ').includes('image attachment dropped'),
        ),
      ).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
});

describe('createAnthropicClient — prompt caching', () => {
  const okFetch = (): FetchSpy =>
    jest.fn().mockResolvedValue(
      buildOk({
        content: [{type: 'text', text: 'ok'}],
        usage: {input_tokens: 1, output_tokens: 1},
      }),
    );

  const sentBody = async (
    req: ReturnType<typeof baseReq> & {imageBase64?: string},
  ) => {
    const fetchFn = okFetch();
    const client = createAnthropicClient(fetchFn as unknown as typeof fetch);
    await client.send(req, {apiKey: 'k', model: 'm'});
    return JSON.parse(fetchFn.mock.calls[0][1].body as string);
  };

  it('marks the image block — the end of the stable prefix', async () => {
    const body = await sentBody({...baseReq(), imageBase64: 'AAAA'});
    const blocks = body.messages[0].content;
    expect(blocks[0].type).toBe('image');
    expect(blocks[0].cache_control).toEqual({type: 'ephemeral'});
  });

  it('leaves the volatile user text outside the cached prefix', async () => {
    const body = await sentBody({...baseReq(), imageBase64: 'AAAA'});
    const blocks = body.messages[0].content;
    // The text block carries the per-request question. A breakpoint
    // here (or at the top level, which auto-places on the LAST block)
    // would cache a prefix no later request can match — every send
    // paying the 1.25x write premium for zero reads.
    expect(blocks[blocks.length - 1].type).toBe('text');
    expect(blocks[blocks.length - 1].cache_control).toBeUndefined();
    expect(body.cache_control).toBeUndefined();
  });

  it('omits the marker entirely when no image is attached', async () => {
    // Text-only paths (Test Connection, Grill judge/rephrase) keep
    // their exact previous wire shape: the system prompt alone is
    // below every model's minimum cacheable size, so a marker there
    // buys nothing and a top-level one is an outright surcharge.
    const body = await sentBody(baseReq());
    expect(body.cache_control).toBeUndefined();
    expect(body.messages[0].content).toEqual([
      {type: 'text', text: 'Hello'},
    ]);
  });

  it('maps cache usage fields from the response', async () => {
    const fetchFn: FetchSpy = jest.fn().mockResolvedValue(
      buildOk({
        content: [{type: 'text', text: 'ok'}],
        usage: {
          input_tokens: 12,
          output_tokens: 7,
          cache_read_input_tokens: 4096,
          cache_creation_input_tokens: 128,
        },
      }),
    );
    const client = createAnthropicClient(fetchFn as unknown as typeof fetch);
    const r = await client.send(baseReq(), {apiKey: 'k', model: 'm'});
    expect(r.usage.cacheReadInputTokens).toBe(4096);
    expect(r.usage.cacheCreationInputTokens).toBe(128);
  });

  it('defaults cache usage to 0 when the API omits the fields', async () => {
    const fetchFn: FetchSpy = jest.fn().mockResolvedValue(
      buildOk({
        content: [{type: 'text', text: 'ok'}],
        usage: {input_tokens: 12, output_tokens: 7},
      }),
    );
    const client = createAnthropicClient(fetchFn as unknown as typeof fetch);
    const r = await client.send(baseReq(), {apiKey: 'k', model: 'm'});
    expect(r.usage.cacheReadInputTokens).toBe(0);
    expect(r.usage.cacheCreationInputTokens).toBe(0);
  });
});

describe('createProviderClient — registry', () => {
  const fetchFn = jest.fn();

  it.each(['anthropic', 'openai', 'gemini', 'deepseek'] as const)(
    'returns a client whose id is %s',
    id => {
      const c = createProviderClient(id, fetchFn as unknown as typeof fetch);
      expect(c.id).toBe(id);
    },
  );
});

describe('multi-turn history mapping', () => {
  const HISTORY = [
    {role: 'user' as const, text: 'Summarize this page'},
    {role: 'assistant' as const, text: '• point one\n• point two'},
  ];

  const okAnthropic = () =>
    buildOk({
      content: [{type: 'text', text: 'ok'}],
      usage: {input_tokens: 1, output_tokens: 1},
    });

  const okChatCompletions = () =>
    buildOk({
      choices: [{message: {content: 'ok'}}],
      usage: {prompt_tokens: 1, completion_tokens: 1},
    });

  it('anthropic: prior turns precede the current user message', async () => {
    const fetchFn: FetchSpy = jest.fn().mockResolvedValue(okAnthropic());
    const client = createAnthropicClient(fetchFn as unknown as typeof fetch);
    await client.send(
      {...baseReq(), history: HISTORY},
      {apiKey: 'k', model: 'm'},
    );
    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string);
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0]).toEqual({
      role: 'user',
      content: 'Summarize this page',
    });
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: '• point one\n• point two',
    });
    // Current message keeps the typed-blocks shape.
    expect(body.messages[2].role).toBe('user');
    expect(body.messages[2].content).toEqual([{type: 'text', text: 'Hello'}]);
  });

  it('openai: history slots between system and the current message', async () => {
    const fetchFn: FetchSpy = jest.fn().mockResolvedValue(okChatCompletions());
    const client = createOpenAIClient(fetchFn as unknown as typeof fetch);
    await client.send(
      {...baseReq(), history: HISTORY},
      {apiKey: 'k', model: 'gpt-4o-mini'},
    );
    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string);
    expect(body.messages.map((m: {role: string}) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(body.messages[1].content).toBe('Summarize this page');
    expect(body.messages[3].content).toBe('Hello');
  });

  it("gemini: assistant turns map to the 'model' role", async () => {
    const fetchFn: FetchSpy = jest.fn().mockResolvedValue(
      buildOk({
        candidates: [{content: {parts: [{text: 'ok'}]}}],
        usageMetadata: {promptTokenCount: 1, candidatesTokenCount: 1},
      }),
    );
    const client = createGeminiClient(fetchFn as unknown as typeof fetch);
    await client.send(
      {...baseReq(), history: HISTORY},
      {apiKey: 'k', model: 'gemini-2.5-flash'},
    );
    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string);
    expect(body.contents).toHaveLength(3);
    expect(body.contents[0]).toEqual({
      role: 'user',
      parts: [{text: 'Summarize this page'}],
    });
    expect(body.contents[1]).toEqual({
      role: 'model',
      parts: [{text: '• point one\n• point two'}],
    });
    expect(body.contents[2].role).toBe('user');
  });

  it('deepseek: history slots between system and the current message', async () => {
    const fetchFn: FetchSpy = jest.fn().mockResolvedValue(okChatCompletions());
    const client = createDeepSeekClient(fetchFn as unknown as typeof fetch);
    await client.send(
      {...baseReq(), history: HISTORY},
      {apiKey: 'k', model: 'deepseek-chat'},
    );
    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string);
    expect(body.messages.map((m: {role: string}) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
  });

  it('omitted history keeps the single-turn shape', async () => {
    // Anthropic (no system message in messages[]) → 1 entry; the
    // chat-completions family (openai/deepseek) → 2 (system + user).
    const anthropicFetch: FetchSpy = jest.fn().mockResolvedValue(okAnthropic());
    const anthropic = createAnthropicClient(
      anthropicFetch as unknown as typeof fetch,
    );
    await anthropic.send(baseReq(), {apiKey: 'k', model: 'm'});
    expect(
      JSON.parse(anthropicFetch.mock.calls[0][1].body as string).messages,
    ).toHaveLength(1);

    const openaiFetch: FetchSpy = jest
      .fn()
      .mockResolvedValue(okChatCompletions());
    const openai = createOpenAIClient(openaiFetch as unknown as typeof fetch);
    await openai.send(baseReq(), {apiKey: 'k', model: 'gpt-4o-mini'});
    expect(
      JSON.parse(openaiFetch.mock.calls[0][1].body as string).messages,
    ).toHaveLength(2);
  });
});
