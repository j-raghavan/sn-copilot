/**
 * Tests for src/scope/pageContext — promise-singleton holding the
 * most recent page-context capture (async since the capture is now
 * fired before the overlay opens).
 *
 * Pins:
 *   1. Initial state resolves to null.
 *   2. setPageContext(ctx) → getPageContext() resolves to ctx.
 *   3. setPageContext(null) clears.
 *   4. setPageContextPromise(p) lets the getter await an in-flight
 *      capture (the whole point of this rewrite).
 *   5. __testing__.reset() returns to the initial state.
 */
import {
  getPageContext,
  setPageContext,
  setPageContextPromise,
  __testing__,
  type PageContext,
} from '../src/scope/pageContext';

beforeEach(() => {
  __testing__.reset();
});

const sample: PageContext = {
  notePath: '/sd/notes/x.note',
  page: 3,
  screenshotPath: '/sd/.scratch/copilot-page.png',
  screenshotBase64: 'aGVsbG8=',
  pageText: 'transcribed page text',
};

describe('pageContext', () => {
  it('initial state resolves to null', async () => {
    expect(await getPageContext()).toBeNull();
  });

  it('setPageContext(ctx) → getPageContext() resolves to ctx', async () => {
    setPageContext(sample);
    expect(await getPageContext()).toBe(sample);
  });

  it('setPageContext(null) clears the singleton', async () => {
    setPageContext(sample);
    setPageContext(null);
    expect(await getPageContext()).toBeNull();
  });

  it('setPageContextPromise: getter awaits the in-flight capture', async () => {
    let resolveIt!: (v: PageContext | null) => void;
    const p = new Promise<PageContext | null>(r => {
      resolveIt = r;
    });
    setPageContextPromise(p);
    // Resolve later — getter should still see the value.
    resolveIt(sample);
    expect(await getPageContext()).toBe(sample);
  });

  it('setPageContextPromise: a still-pending capture yields when awaited', async () => {
    let resolveIt!: (v: PageContext | null) => void;
    const p = new Promise<PageContext | null>(r => {
      resolveIt = r;
    });
    setPageContextPromise(p);
    const reader = getPageContext();
    // The reader is awaiting — resolve and verify it picks up the value.
    resolveIt(sample);
    expect(await reader).toBe(sample);
  });

  it('__testing__.reset() returns to null', async () => {
    setPageContext(sample);
    __testing__.reset();
    expect(await getPageContext()).toBeNull();
  });
});
