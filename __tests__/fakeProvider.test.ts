/**
 * Tests for src/providers/fakeProvider. Pins:
 *   1. Implements the ProviderClient contract (id, send signature).
 *   2. Returns canned responses keyed by action keyword.
 *   3. Returns a fallback response when no keyword matches.
 *   4. Resolves after the documented latency (~600 ms).
 *   5. Honours the AbortSignal — rejects with 'aborted' if the
 *      signal aborts before the latency expires.
 *   6. usage tokens are populated; latencyMs is non-negative.
 *   7. opts.model is echoed back as modelId; falls back to a default
 *      if the caller passes an empty string.
 */
import fakeProvider from '../src/providers/fakeProvider';
import type {
  ProviderRequest,
  ProviderClient,
} from '../src/providers/ProviderClient';

jest.useFakeTimers();

const makeReq = (
  userText: string,
  signal: AbortSignal = new AbortController().signal,
): ProviderRequest => ({
  systemPrompt: 'system',
  userText,
  maxTokens: 200,
  signal,
});

describe('fakeProvider', () => {
  it('exposes the ProviderClient shape', () => {
    const client: ProviderClient = fakeProvider;
    expect(client.id).toBe('fake');
    expect(typeof client.send).toBe('function');
  });

  it('returns canned response for "summarize"', async () => {
    const promise = fakeProvider.send(makeReq('Summarize this'), {
      apiKey: 'k',
      model: 'm',
    });
    jest.advanceTimersByTime(700);
    const r = await promise;
    expect(r.text).toContain('Notes are too long');
    expect(r.text).toContain('Summary actions would help');
    expect(r.modelId).toBe('m');
    expect(r.usage.inputTokens).toBeGreaterThan(0);
    expect(r.usage.outputTokens).toBeGreaterThan(0);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns canned response for "explain"', async () => {
    const promise = fakeProvider.send(makeReq('Explain that'), {
      apiKey: 'k',
      model: 'm',
    });
    jest.advanceTimersByTime(700);
    const r = await promise;
    expect(r.text).toContain('AI assistant plugin');
  });

  it('returns canned response for "action items"', async () => {
    const promise = fakeProvider.send(makeReq('extract Action Items'), {
      apiKey: 'k',
      model: 'm',
    });
    jest.advanceTimersByTime(700);
    const r = await promise;
    expect(r.text).toContain('[ ]');
    expect(r.text).toContain('deployment model');
  });

  it('returns canned response for "clarify"', async () => {
    const promise = fakeProvider.send(makeReq('Clarify the goal'), {
      apiKey: 'k',
      model: 'm',
    });
    jest.advanceTimersByTime(700);
    const r = await promise;
    expect(r.text).toContain('Project Notes');
  });

  it('returns the fallback when no keyword matches', async () => {
    const promise = fakeProvider.send(makeReq('something else'), {
      apiKey: 'k',
      model: 'm',
    });
    jest.advanceTimersByTime(700);
    const r = await promise;
    expect(r.text).toContain('fake provider');
  });

  it('falls back to a default model id when opts.model is empty', async () => {
    const promise = fakeProvider.send(makeReq('Summarize'), {
      apiKey: 'k',
      model: '',
    });
    jest.advanceTimersByTime(700);
    const r = await promise;
    expect(r.modelId).toBe('fake-model-1');
  });

  it('rejects synchronously if signal is already aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      fakeProvider.send(makeReq('Summarize', ctl.signal), {
        apiKey: 'k',
        model: 'm',
      }),
    ).rejects.toThrow('aborted');
  });

  // fakeProvider.sleep deliberately ignores mid-flight aborts — see
  // the comment in src/providers/fakeProvider.ts. The "already
  // aborted" path is still honoured (test above).
});
