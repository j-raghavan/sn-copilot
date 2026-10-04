/**
 * Tests for src/ui/PilotChatScreen — the PilotChat's full-screen view.
 *
 * Pins:
 *   1. 'Opening…' until the wiring bundle resolves; a bundle that fails
 *      or resolves after unmount never renders the page.
 *   2. Close → PluginManager.closePluginView; Ask → askNow on the page.
 *   3. notePen comes from getPenInfo when it is a pen, else stays null.
 *   4. A question: its handwriting image is asked with the page's history,
 *      the answer is written back and the header shows what the model
 *      read; the next question carries the earlier Q/A as text.
 *   5. No key → NEEDS_KEY; a locked store → NEEDS_UNLOCK; a provider
 *      that cannot see (DeepSeek) → NEEDS_VISION; no image →
 *      FAILED_REPLY. None of them asks the model.
 *   6. A failed ask writes a sanitised note on the page and leaves the
 *      history untouched; a failure before asking gets a plain note.
 *   7. A question arriving while one is in flight is not asked, but gets a
 *      note, so the page stops waiting; New aborts the one in flight and
 *      drops whatever it brings back.
 *   8. The image is taken from the event before the handler first awaits:
 *      React Native recycles the event after that.
 *   9. The PilotChat's own messages go through appendNote (never into the
 *      note); answers through appendAnswer.
 *  10. Ink is off on the page while the insert offer covers it.
 *  11. Close with nothing written closes; after writing it offers to
 *      insert. Keep writing hides the offer; Discard closes unwritten.
 *  12. Insert: resolve the note target, export the page measured for it,
 *      lay it out, write it, close. Failures keep the view open with a
 *      status message. The SDK bindings reach sn-plugin-lib.
 */
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import type {AppState} from '../src/storage/appState';
import type {KeyFile} from '../src/types';

const mockClosePluginView = jest.fn(async () => true);
const mockGetPenInfo = jest.fn();
const mockCreateElement = jest.fn(async (_t: number) => ({
  success: true,
  result: {},
}));

const mockSdk = {
  getCurrentFilePath: jest.fn(async () => ({success: true, result: '/n.note'})),
  getCurrentPageNum: jest.fn(async () => ({success: true, result: 2})),
  reloadFile: jest.fn(async () => ({success: true})),
  jumpToPage: jest.fn(async (_p: number) => ({success: true})),
  getPageSize: jest.fn(async (_n: string, _p: number) => ({success: true})),
  getNotePageTemplate: jest.fn(async (_n: string, _p: number) => ({
    success: true,
  })),
  insertNotePage: jest.fn(async (_p: unknown) => ({success: true})),
  removeNotePage: jest.fn(async (_n: string, _p: number) => ({success: true})),
  getElements: jest.fn(async (_p: number, _n: string) => ({success: true})),
  insertElements: jest.fn(async (_n: string, _p: number, _e: unknown) => ({
    success: true,
  })),
  saveCurrentNote: jest.fn(async () => ({success: true})),
  androidPoint2Emr: jest.fn((_p: unknown, _s: unknown) => ({x: 1, y: 2})),
  getRealMaxX: jest.fn((_s: unknown) => 21632),
  getRealMaxY: jest.fn((_s: unknown) => 16224),
};

jest.mock('sn-plugin-lib', () => ({
  PluginCommAPI: {
    getPenInfo: () => mockGetPenInfo(),
    createElement: (t: number) => mockCreateElement(t),
    getCurrentFilePath: () => mockSdk.getCurrentFilePath(),
    getCurrentPageNum: () => mockSdk.getCurrentPageNum(),
    reloadFile: () => mockSdk.reloadFile(),
    jumpToPage: (p: number) => mockSdk.jumpToPage(p),
  },
  PluginFileAPI: {
    getPageSize: (n: string, p: number) => mockSdk.getPageSize(n, p),
    getNotePageTemplate: (n: string, p: number) =>
      mockSdk.getNotePageTemplate(n, p),
    insertNotePage: (p: unknown) => mockSdk.insertNotePage(p),
    removeNotePage: (n: string, p: number) => mockSdk.removeNotePage(n, p),
    getElements: (p: number, n: string) => mockSdk.getElements(p, n),
    insertElements: (n: string, p: number, e: unknown) =>
      mockSdk.insertElements(n, p, e),
  },
  PluginNoteAPI: {saveCurrentNote: () => mockSdk.saveCurrentNote()},
  PointUtils: {
    androidPoint2Emr: (p: unknown, s: unknown) =>
      mockSdk.androidPoint2Emr(p, s),
    getRealMaxX: (s: unknown) => mockSdk.getRealMaxX(s),
    getRealMaxY: (s: unknown) => mockSdk.getRealMaxY(s),
  },
  PluginManager: {closePluginView: () => mockClosePluginView()},
}));

const PAGE_HANDLE = {page: 'handle'};
const mockAskNow = jest.fn();
const mockAppendAnswer = jest.fn();
const mockAppendNote = jest.fn();
const mockExportForNote = jest.fn();
jest.mock('../src/native/PilotChatPageView', () => {
  const R = require('react');
  const {View} = require('react-native');
  const Page = R.forwardRef((props: Record<string, unknown>, ref: unknown) => {
    R.useImperativeHandle(ref, () => PAGE_HANDLE);
    return R.createElement(View, {...props, testID: 'pilotchat-page'});
  });
  return {
    PilotChatPageNativeView: Page,
    askNow: (v: unknown) => mockAskNow(v),
    appendAnswer: (v: unknown, t: string) => mockAppendAnswer(v, t),
    appendNote: (v: unknown, t: string) => mockAppendNote(v, t),
    exportForNote: (v: unknown, f: number, w: number, h: number) =>
      mockExportForNote(v, f, w, h),
    clearPage: (v: unknown) => mockClearPage(v),
    scrollPage: (v: unknown, d: number) => mockScrollPage(v, d),
  };
});

const mockClearPage = jest.fn();
const mockScrollPage = jest.fn();
const mockResolveNoteTarget = jest.fn();
const mockWriteToNote = jest.fn();
const mockRemoveInsertion = jest.fn();
jest.mock('../src/pilotchat/writeToNote', () => ({
  NoteWriteError: jest.requireActual('../src/pilotchat/writeToNote')
    .NoteWriteError,
  signaturesOf: jest.requireActual('../src/pilotchat/writeToNote').signaturesOf,
  removeInsertion: (i: unknown, d: unknown) => mockRemoveInsertion(i, d),
  resolveNoteTarget: (d: unknown) => mockResolveNoteTarget(d),
  writeToNote: (p: unknown, t: unknown, d: unknown, s: unknown) =>
    mockWriteToNote(p, t, d, s),
}));

const BUNDLE = {
  prefsDeps: {},
  vaultDeps: {logger: undefined},
  discoveryDeps: {},
};
const mockBuildWiringBundle = jest.fn();
jest.mock('../src/storage/wiring', () => ({
  buildWiringBundle: () => mockBuildWiringBundle(),
}));

let mockState: AppState | null = null;
const mockRefresh = jest.fn(async () => undefined);
jest.mock('../src/storage/useCopilotState', () => ({
  useCopilotState: () => ({state: mockState, refresh: mockRefresh}),
}));

// The button presses PilotChat listens for, to look at the keys again.
let mockButtonSubscriber: ((e: {id: number}) => void) | null = null;
jest.mock('../src/pluginRouter', () => ({
  BUTTON_ID_PILOTCHAT: 400,
  subscribeToButtonEvents: (fn: (e: {id: number}) => void) => {
    mockButtonSubscriber = fn;
    return () => {
      mockButtonSubscriber = null;
    };
  },
}));

const mockAskPilotChat = jest.fn();
jest.mock('../src/pilotchat/askPilotChat', () => ({
  askPilotChat: (p: unknown) => mockAskPilotChat(p),
}));

import PilotChatScreen, {
  FAILED_REPLY,
  STILL_ANSWERING_REPLY,
} from '../src/ui/PilotChatScreen';
import {sanitizeProviderError} from '../src/ui/sanitizeProviderError';
import {
  headerDate,
  layoutForNote,
  noteTextStyle,
} from '../src/pilotchat/noteLayout';
import {NoteWriteError, signaturesOf} from '../src/pilotchat/writeToNote';
import {Text} from 'react-native';
import {
  NEEDS_KEY,
  NEEDS_KEY_SETUP,
  NEEDS_UNLOCK,
  NEEDS_VISION,
} from '../src/pilotchat/readiness';

const KEY: KeyFile = {
  provider: 'anthropic',
  model: 'claude-x',
  key: 'sk-ant-test',
  sourcePath: '/MyStyle/SnCopilot/copilot-key-anthropic.txt',
};

const STROKES = [[10, 20, 30, 40]];
const IMAGE = 'iVBORw0KGgo=';
const REPLY = {question: 'what is a qubit', answer: 'A qubit is both.'};

const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise(r => setImmediate(r));
    });
  }
};

const render = async (): Promise<ReactTestRenderer> => {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<PilotChatScreen />);
  });
  await flush();
  return tree;
};

// The keys change (in Copilot, while PilotChat is open or hidden) and
// PilotChat renders again.
const keysBecome = async (tree: ReactTestRenderer, next: AppState | null) => {
  mockState = next;
  await act(async () => {
    tree.update(<PilotChatScreen />);
  });
};

const page = (tree: ReactTestRenderer) =>
  tree.root.findByProps({testID: 'pilotchat-page'});

const status = (tree: ReactTestRenderer): string =>
  ([] as unknown[])
    .concat(tree.root.findByProps({testID: 'pilotchat-status'}).props.children)
    .join('');

const ask = async (
  tree: ReactTestRenderer,
  image: string | undefined = IMAGE,
  strokes = STROKES,
) => {
  await act(async () => {
    await page(tree).props.onQuestion({nativeEvent: {strokes, image}});
  });
};

const TARGET = {
  notePath: '/n.note',
  page: 2,
  pageSize: {width: 1920, height: 2560},
};

const PAYLOAD = {
  pageWidth: 1920,
  items: [
    {kind: 'writing' as const, strokes: [[100, 200, 300, 260]]},
    {kind: 'paragraph' as const, text: 'A qubit is both.', height: 40},
  ],
};

const press = async (tree: ReactTestRenderer, testID: string) => {
  await act(async () => {
    await tree.root.findByProps({testID}).props.onPress();
  });
};

const text = (tree: ReactTestRenderer, testID: string): string =>
  tree.root.findByProps({testID}).findByType(Text).props.children;

const has = (tree: ReactTestRenderer, testID: string): boolean =>
  tree.root.findAllByProps({testID}).length > 0;

const exportPage = async (tree: ReactTestRenderer, payload = PAYLOAD) => {
  await act(async () => {
    await page(tree).props.onExport({nativeEvent: payload});
  });
};

let warn: jest.SpyInstance;
let log: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  mockState = {kind: 'plaintext', files: [KEY]};
  mockBuildWiringBundle.mockResolvedValue(BUNDLE);
  mockGetPenInfo.mockResolvedValue({
    success: true,
    result: {type: 15, width: 2400, color: 0},
  });
  mockAskPilotChat.mockResolvedValue(REPLY);
  mockResolveNoteTarget.mockResolvedValue(TARGET);
  mockWriteToNote.mockResolvedValue(1);
  mockRemoveInsertion.mockResolvedValue({removed: true});
});

afterEach(() => {
  warn.mockRestore();
  log.mockRestore();
});

describe('PilotChatScreen — opening', () => {
  it('shows Opening… until the wiring bundle resolves', async () => {
    let resolve!: (b: unknown) => void;
    mockBuildWiringBundle.mockReturnValue(new Promise(r => (resolve = r)));
    const tree = await render();
    expect(status(tree)).toBe('Opening…');
    expect(tree.root.findAllByProps({testID: 'pilotchat-page'})).toHaveLength(
      0,
    );
    expect(tree.root.findAllByProps({testID: 'pilotchat-ask'})).toHaveLength(0);
    await act(async () => resolve(BUNDLE));
    await flush();
    expect(page(tree)).toBeDefined();
    expect(status(tree)).toBe('Write a question, then rest the pen');
  });

  it('stays on Opening… when the wiring bundle fails', async () => {
    mockBuildWiringBundle.mockRejectedValue(new Error('wiring boom'));
    const tree = await render();
    expect(status(tree)).toBe('Opening…');
  });

  it('ignores a bundle that resolves after unmount', async () => {
    let resolve!: (b: unknown) => void;
    mockBuildWiringBundle.mockReturnValue(new Promise(r => (resolve = r)));
    const tree = await render();
    await act(async () => tree.unmount());
    await act(async () => resolve(BUNDLE));
    expect(tree.toJSON()).toBeNull();
  });
});

describe('PilotChatScreen — controls', () => {
  it('Close closes the plugin view', async () => {
    const tree = await render();
    await act(async () =>
      tree.root.findByProps({testID: 'pilotchat-close'}).props.onPress(),
    );
    expect(mockClosePluginView).toHaveBeenCalledTimes(1);
  });

  it('Close survives a closePluginView rejection', async () => {
    mockClosePluginView.mockRejectedValueOnce(new Error('close boom'));
    const tree = await render();
    await act(async () =>
      tree.root.findByProps({testID: 'pilotchat-close'}).props.onPress(),
    );
    expect(mockClosePluginView).toHaveBeenCalled();
  });

  it('Ask takes the question now, on the page', async () => {
    const tree = await render();
    await act(async () =>
      tree.root.findByProps({testID: 'pilotchat-ask'}).props.onPress(),
    );
    expect(mockAskNow).toHaveBeenCalledWith(PAGE_HANDLE);
  });
});

describe('PilotChatScreen — the note pen', () => {
  it('hands the page the note pen getPenInfo reports', async () => {
    const tree = await render();
    expect(page(tree).props.notePen).toEqual({type: 15, width: 2400, color: 0});
  });

  it.each([
    ['no result', {success: false}],
    ['a pen missing a field', {success: true, result: {type: 15, width: 2}}],
    ['null', null],
  ])('leaves notePen null for %s', async (_l, raw) => {
    mockGetPenInfo.mockResolvedValue(raw);
    const tree = await render();
    expect(page(tree).props.notePen).toBeNull();
  });

  it('leaves notePen null when getPenInfo rejects', async () => {
    mockGetPenInfo.mockRejectedValue(new Error('pen boom'));
    const tree = await render();
    expect(page(tree).props.notePen).toBeNull();
  });
});

describe('PilotChatScreen — asking', () => {
  it('asks with the handwriting image, writes the answer, and shows what was read', async () => {
    const tree = await render();
    await ask(tree);
    expect(mockAskPilotChat).toHaveBeenCalledWith(
      expect.objectContaining({
        imageBase64: IMAGE,
        history: [],
        apiKey: 'sk-ant-test',
        model: 'claude-x',
      }),
    );
    expect(mockAppendAnswer).toHaveBeenCalledWith(
      PAGE_HANDLE,
      'A qubit is both.',
    );
    expect(mockAppendNote).not.toHaveBeenCalled();
    expect(status(tree)).toBe('Read: what is a qubit');
  });

  it('shows Reading your writing… while the model reads', async () => {
    let resolve!: (r: typeof REPLY) => void;
    mockAskPilotChat.mockReturnValueOnce(new Promise(r => (resolve = r)));
    const tree = await render();
    let first!: Promise<void>;
    await act(async () => {
      first = page(tree).props.onQuestion({
        nativeEvent: {strokes: STROKES, image: IMAGE},
      });
    });
    expect(status(tree)).toBe('Reading your writing…');
    await act(async () => {
      resolve(REPLY);
      await first;
    });
  });

  it('carries earlier questions and answers into the next ask, as text', async () => {
    const tree = await render();
    await ask(tree);
    mockAskPilotChat.mockResolvedValue({
      question: 'and a qutrit?',
      answer: 'Three states.',
    });
    await ask(tree);
    expect(mockAskPilotChat.mock.calls[1][0].history).toEqual([
      {role: 'user', text: 'what is a qubit'},
      {role: 'assistant', text: 'A qubit is both.'},
    ]);
  });

  it('records an unread question by hand, and goes back to idle', async () => {
    mockAskPilotChat.mockResolvedValueOnce({
      question: '',
      answer: 'Here is why.',
    });
    const tree = await render();
    await ask(tree);
    expect(status(tree)).toBe('Write a question, then rest the pen');
    await ask(tree);
    expect(mockAskPilotChat.mock.calls[1][0].history[0]).toEqual({
      role: 'user',
      text: '(a question written by hand)',
    });
  });

  it('says how to set up a key mid-conversation when there is none', async () => {
    const tree = await render();
    await ask(tree);
    await keysBecome(tree, {kind: 'no-key'});
    await ask(tree);
    expect(mockAskPilotChat).toHaveBeenCalledTimes(1);
    expect(mockAppendNote).toHaveBeenCalledWith(PAGE_HANDLE, NEEDS_KEY);
  });

  it('says how to unlock mid-conversation when the key store is locked', async () => {
    const tree = await render();
    await ask(tree);
    await keysBecome(tree, {kind: 'locked'});
    await ask(tree);
    expect(mockAskPilotChat).toHaveBeenCalledTimes(1);
    expect(mockAppendNote).toHaveBeenCalledWith(PAGE_HANDLE, NEEDS_UNLOCK);
  });

  it('says to finish setting up new key files mid-conversation', async () => {
    const tree = await render();
    await ask(tree);
    await keysBecome(tree, {
      kind: 'merge',
      vaultExists: true,
      plaintextFiles: [KEY],
    });
    await ask(tree);
    expect(mockAskPilotChat).toHaveBeenCalledTimes(1);
    expect(mockAppendNote).toHaveBeenCalledWith(PAGE_HANDLE, NEEDS_KEY_SETUP);
  });

  it('says it needs a provider that can see, for DeepSeek mid-conversation', async () => {
    const tree = await render();
    await ask(tree);
    await keysBecome(tree, {
      kind: 'plaintext',
      files: [{...KEY, provider: 'deepseek', model: 'deepseek-chat'}],
    });
    await ask(tree);
    expect(mockAskPilotChat).toHaveBeenCalledTimes(1);
    expect(mockAppendNote).toHaveBeenCalledWith(PAGE_HANDLE, NEEDS_VISION);
    expect(status(tree)).toBe('Write a question, then rest the pen');
  });

  it('writes a plain note and asks nothing when the page sent no image', async () => {
    const tree = await render();
    await act(async () => {
      await page(tree).props.onQuestion({nativeEvent: {strokes: STROKES}});
    });
    expect(mockAskPilotChat).not.toHaveBeenCalled();
    expect(mockAppendNote).toHaveBeenCalledWith(PAGE_HANDLE, FAILED_REPLY);
  });

  it('writes a sanitised note when the ask fails, and keeps it out of the history', async () => {
    const err = new Error('HTTP 500 boom');
    mockAskPilotChat.mockRejectedValueOnce(err);
    const tree = await render();
    await ask(tree);
    expect(mockAppendNote).toHaveBeenCalledWith(
      PAGE_HANDLE,
      `(${sanitizeProviderError(err)})`,
    );
    expect(mockAppendAnswer).not.toHaveBeenCalled();
    expect(status(tree)).toBe('Write a question, then rest the pen');
    await ask(tree);
    expect(mockAskPilotChat.mock.calls[1][0].history).toEqual([]);
  });

  it('does not blame the provider for a failure before the ask', async () => {
    const tree = await render();
    await ask(tree);
    await keysBecome(tree, {kind: 'no-key'});
    mockAppendNote.mockImplementationOnce(() => {
      throw new TypeError('boom');
    });
    await ask(tree);
    expect(mockAppendNote).toHaveBeenLastCalledWith(PAGE_HANDLE, FAILED_REPLY);
    expect(mockAskPilotChat).toHaveBeenCalledTimes(1);
  });

  it('reads the image before React Native recycles the event', async () => {
    const tree = await render();
    const event: {nativeEvent: {strokes: number[][]; image: string} | null} = {
      nativeEvent: {strokes: STROKES, image: IMAGE},
    };
    await act(async () => {
      const handled = page(tree).props.onQuestion(event);
      // What the RN event system does once the handler yields.
      event.nativeEvent = null;
      await handled;
    });
    expect(mockAskPilotChat).toHaveBeenCalledWith(
      expect.objectContaining({imageBase64: IMAGE}),
    );
    expect(log).not.toHaveBeenCalledWith(
      '[PILOTCHAT] question failed',
      expect.anything(),
    );
  });

  it('answers a question that arrives while one is in flight with a note', async () => {
    let resolve!: (r: typeof REPLY) => void;
    mockAskPilotChat.mockReturnValueOnce(new Promise(r => (resolve = r)));
    const tree = await render();
    let first!: Promise<void>;
    await act(async () => {
      first = page(tree).props.onQuestion({
        nativeEvent: {strokes: STROKES, image: IMAGE},
      });
    });
    await ask(tree, IMAGE, [[1, 2]]);
    expect(mockAskPilotChat).toHaveBeenCalledTimes(1);
    expect(mockAppendNote).toHaveBeenCalledWith(
      PAGE_HANDLE,
      STILL_ANSWERING_REPLY,
    );
    await act(async () => {
      resolve({question: 'q', answer: 'done'});
      await first;
    });
    expect(mockAppendAnswer).toHaveBeenCalledWith(PAGE_HANDLE, 'done');
    // Free again once the first answer is in.
    await ask(tree);
    expect(mockAskPilotChat).toHaveBeenCalledTimes(2);
  });
});

describe('PilotChatScreen — New while answering', () => {
  const pending = async () => {
    let resolve!: (r: typeof REPLY) => void;
    let reject!: (e: unknown) => void;
    mockAskPilotChat.mockReturnValueOnce(
      new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      }),
    );
    const tree = await render();
    let first!: Promise<void>;
    await act(async () => {
      first = page(tree).props.onQuestion({
        nativeEvent: {strokes: STROKES, image: IMAGE},
      });
    });
    await press(tree, 'pilotchat-new');
    await press(tree, 'pilotchat-discard');
    return {tree, first, resolve, reject};
  };

  it('aborts the question being answered', async () => {
    await pending();
    expect(mockAskPilotChat.mock.calls[0][0].signal.aborted).toBe(true);
  });

  it('drops an answer that arrives after New, and asks the next question fresh', async () => {
    const {tree, first, resolve} = await pending();
    await ask(tree);
    expect(mockAskPilotChat).toHaveBeenCalledTimes(2);
    expect(mockAskPilotChat.mock.calls[1][0].history).toEqual([]);
    await act(async () => {
      resolve({question: 'old', answer: 'stale'});
      await first;
    });
    expect(mockAppendAnswer).not.toHaveBeenCalledWith(PAGE_HANDLE, 'stale');
    await ask(tree);
    expect(
      mockAskPilotChat.mock.calls[2][0].history.map(
        (t: {text: string}) => t.text,
      ),
    ).not.toContain('stale');
  });

  it('says nothing about the aborted question failing', async () => {
    const {first, reject} = await pending();
    await act(async () => {
      reject(new Error('aborted'));
      await first;
    });
    expect(mockAppendNote).not.toHaveBeenCalled();
  });
});

describe('PilotChatScreen — closing', () => {
  it('closes at once when nothing was written', async () => {
    const tree = await render();
    await press(tree, 'pilotchat-close');
    expect(mockClosePluginView).toHaveBeenCalledTimes(1);
    expect(has(tree, 'pilotchat-insert-prompt')).toBe(false);
  });

  it('offers to insert after the user wrote', async () => {
    const tree = await render();
    await ask(tree);
    await press(tree, 'pilotchat-close');
    expect(mockClosePluginView).not.toHaveBeenCalled();
    expect(has(tree, 'pilotchat-insert-prompt')).toBe(true);
  });

  it('offers to insert even when the question could not be asked', async () => {
    const tree = await render();
    mockAskPilotChat.mockRejectedValueOnce(new Error('offline'));
    await ask(tree);
    await press(tree, 'pilotchat-close');
    expect(has(tree, 'pilotchat-insert-prompt')).toBe(true);
  });

  it('turns ink off while the offer covers the page, and back on after', async () => {
    const tree = await render();
    expect(page(tree).props.inkEnabled).toBe(true);
    await ask(tree);
    await press(tree, 'pilotchat-close');
    expect(page(tree).props.inkEnabled).toBe(false);
    await press(tree, 'pilotchat-keep-writing');
    expect(page(tree).props.inkEnabled).toBe(true);
  });

  it('Keep writing hides the offer and writes nothing', async () => {
    const tree = await render();
    await ask(tree);
    await press(tree, 'pilotchat-close');
    await press(tree, 'pilotchat-keep-writing');
    expect(has(tree, 'pilotchat-insert-prompt')).toBe(false);
    expect(mockClosePluginView).not.toHaveBeenCalled();
    expect(mockResolveNoteTarget).not.toHaveBeenCalled();
  });

  it('Not now closes without writing into the note', async () => {
    const tree = await render();
    await ask(tree);
    await press(tree, 'pilotchat-close');
    expect(text(tree, 'pilotchat-discard')).toBe('Not now');
    await press(tree, 'pilotchat-discard');
    expect(mockClosePluginView).toHaveBeenCalledTimes(1);
    expect(mockResolveNoteTarget).not.toHaveBeenCalled();
    expect(mockWriteToNote).not.toHaveBeenCalled();
  });

  it('Not now keeps the conversation to carry on with when reopened', async () => {
    const tree = await render();
    await ask(tree);
    await press(tree, 'pilotchat-close');
    await press(tree, 'pilotchat-discard');
    expect(has(tree, 'pilotchat-insert-prompt')).toBe(false);
    expect(page(tree).props.inkEnabled).toBe(true);
    expect(mockClearPage).not.toHaveBeenCalled();
    await ask(tree);
    expect(mockAskPilotChat.mock.calls[1][0].history).toHaveLength(2);
  });
});

describe('PilotChatScreen — scrolling', () => {
  it('scrolls the page up and down from the header buttons', async () => {
    const tree = await render();
    await press(tree, 'pilotchat-up');
    expect(mockScrollPage).toHaveBeenLastCalledWith(PAGE_HANDLE, -1);
    await press(tree, 'pilotchat-down');
    expect(mockScrollPage).toHaveBeenLastCalledWith(PAGE_HANDLE, 1);
  });
});

describe('PilotChatScreen — starting a new page', () => {
  it('starts afresh at once when nothing was written', async () => {
    const tree = await render();
    await press(tree, 'pilotchat-new');
    expect(mockClearPage).toHaveBeenCalledWith(PAGE_HANDLE);
    expect(has(tree, 'pilotchat-insert-prompt')).toBe(false);
    expect(mockClosePluginView).not.toHaveBeenCalled();
  });

  it('offers to insert first after the user wrote', async () => {
    const tree = await render();
    await ask(tree);
    await press(tree, 'pilotchat-new');
    expect(mockClearPage).not.toHaveBeenCalled();
    expect(has(tree, 'pilotchat-insert-prompt')).toBe(true);
    expect(
      tree.root.findByProps({testID: 'pilotchat-prompt-title'}).props.children,
    ).toBe('Start a new page? Insert this one into your note first?');
  });

  it('Discard starts afresh, forgetting the conversation, and stays open', async () => {
    const tree = await render();
    await ask(tree);
    await press(tree, 'pilotchat-new');
    await press(tree, 'pilotchat-discard');
    expect(mockClearPage).toHaveBeenCalledWith(PAGE_HANDLE);
    expect(mockClosePluginView).not.toHaveBeenCalled();
    expect(mockWriteToNote).not.toHaveBeenCalled();
    expect(status(tree)).toBe('Write a question, then rest the pen');
    // The model no longer sees the old questions.
    await ask(tree);
    expect(mockAskPilotChat.mock.calls[1][0].history).toEqual([]);
  });

  it('Insert writes the page, leaves the note on its last page, and starts afresh', async () => {
    const tree = await render();
    await ask(tree);
    await press(tree, 'pilotchat-new');
    await press(tree, 'pilotchat-insert');
    await exportPage(tree);
    expect(mockWriteToNote.mock.calls[0][3]).toBe('last');
    expect(mockClearPage).toHaveBeenCalledWith(PAGE_HANDLE);
    expect(mockClosePluginView).not.toHaveBeenCalled();
    expect(has(tree, 'pilotchat-insert-prompt')).toBe(false);
  });

  it('after starting afresh, Close leaves at once', async () => {
    const tree = await render();
    await ask(tree);
    await press(tree, 'pilotchat-new');
    await press(tree, 'pilotchat-discard');
    await press(tree, 'pilotchat-close');
    expect(mockClosePluginView).toHaveBeenCalledTimes(1);
  });
});

describe('PilotChatScreen — inserting into the note', () => {
  const openPrompt = async (): Promise<ReactTestRenderer> => {
    const tree = await render();
    await ask(tree);
    await press(tree, 'pilotchat-close');
    return tree;
  };

  it('asks the page for its content measured for the note page', async () => {
    const tree = await openPrompt();
    await press(tree, 'pilotchat-insert');
    const style = noteTextStyle(TARGET.pageSize);
    expect(mockExportForNote).toHaveBeenCalledWith(
      PAGE_HANDLE,
      style.fontSize,
      style.textWidth,
      style.maxHeight,
    );
    expect(has(tree, 'pilotchat-inserting')).toBe(true);
    expect(status(tree)).toBe('Writing into your note…');
    expect(mockWriteToNote).not.toHaveBeenCalled();
  });

  it('lays out and writes the export, then closes', async () => {
    const tree = await openPrompt();
    await press(tree, 'pilotchat-insert');
    await exportPage(tree);
    expect(mockWriteToNote).toHaveBeenCalledWith(
      layoutForNote(PAYLOAD, TARGET.pageSize, headerDate(new Date())),
      TARGET,
      expect.anything(),
      'first',
    );
    expect(mockClosePluginView).toHaveBeenCalledTimes(1);
  });

  it('holds the export before React Native recycles the event', async () => {
    const tree = await openPrompt();
    await press(tree, 'pilotchat-insert');
    const event: {nativeEvent: typeof PAYLOAD | null} = {nativeEvent: PAYLOAD};
    await act(async () => {
      const handled = page(tree).props.onExport(event);
      event.nativeEvent = null;
      await handled;
    });
    expect(mockWriteToNote.mock.calls[0][0]).toEqual(
      layoutForNote(PAYLOAD, TARGET.pageSize, headerDate(new Date())),
    );
    expect(mockClosePluginView).toHaveBeenCalled();
  });

  it('ignores an export nobody asked for', async () => {
    const tree = await render();
    await exportPage(tree);
    expect(mockWriteToNote).not.toHaveBeenCalled();
    expect(mockClosePluginView).not.toHaveBeenCalled();
  });

  it('only writes once per Insert', async () => {
    const tree = await openPrompt();
    await press(tree, 'pilotchat-insert');
    await exportPage(tree);
    await exportPage(tree);
    expect(mockWriteToNote).toHaveBeenCalledTimes(1);
  });

  it('stays open with the reason when the note cannot be found', async () => {
    mockResolveNoteTarget.mockRejectedValueOnce(
      new NoteWriteError('No open note to write into'),
    );
    const tree = await openPrompt();
    await press(tree, 'pilotchat-insert');
    expect(mockExportForNote).not.toHaveBeenCalled();
    expect(has(tree, 'pilotchat-insert-prompt')).toBe(false);
    expect(status(tree)).toBe(
      "Couldn't write into the note: No open note to write into",
    );
    expect(mockClosePluginView).not.toHaveBeenCalled();
  });

  it('stays open with the reason when writing fails', async () => {
    mockWriteToNote.mockRejectedValueOnce(
      new NoteWriteError('insertElements failed'),
    );
    const tree = await openPrompt();
    await press(tree, 'pilotchat-insert');
    await exportPage(tree);
    expect(status(tree)).toBe(
      "Couldn't write into the note: insertElements failed",
    );
    expect(mockClosePluginView).not.toHaveBeenCalled();
    // The pending insert is cleared: a stray export writes nothing more.
    await exportPage(tree);
    expect(mockWriteToNote).toHaveBeenCalledTimes(1);
  });

  it('gives a plain message for an unexpected failure', async () => {
    mockWriteToNote.mockRejectedValueOnce(new TypeError('boom'));
    const tree = await openPrompt();
    await press(tree, 'pilotchat-insert');
    await exportPage(tree);
    expect(status(tree)).toBe("Couldn't write into the note.");
    expect(has(tree, 'pilotchat-insert-prompt')).toBe(false);
  });

  it('binds the note writer to sn-plugin-lib', async () => {
    const tree = await openPrompt();
    await press(tree, 'pilotchat-insert');
    const deps = mockResolveNoteTarget.mock.calls[0][0];
    const size = {width: 1920, height: 2560};
    await deps.getCurrentFilePath();
    expect(mockSdk.getCurrentFilePath).toHaveBeenCalled();
    await deps.getCurrentPageNum();
    expect(mockSdk.getCurrentPageNum).toHaveBeenCalled();
    await deps.getPageSize('/n.note', 2);
    expect(mockSdk.getPageSize).toHaveBeenCalledWith('/n.note', 2);
    await deps.saveCurrentNote();
    expect(mockSdk.saveCurrentNote).toHaveBeenCalled();
    await deps.getNotePageTemplate('/n.note', 2);
    expect(mockSdk.getNotePageTemplate).toHaveBeenCalledWith('/n.note', 2);
    const params = {notePath: '/n.note', page: 3, template: 'style_blank'};
    await deps.insertNotePage(params);
    expect(mockSdk.insertNotePage).toHaveBeenCalledWith(params);
    await deps.removeNotePage('/n.note', 4);
    expect(mockSdk.removeNotePage).toHaveBeenCalledWith('/n.note', 4);
    await deps.getElements(2, '/n.note');
    expect(mockSdk.getElements).toHaveBeenCalledWith(2, '/n.note');
    await deps.createElement(500);
    expect(mockCreateElement).toHaveBeenCalledWith(500);
    await deps.insertElements('/n.note', 3, ['e']);
    expect(mockSdk.insertElements).toHaveBeenCalledWith('/n.note', 3, ['e']);
    await deps.reloadFile();
    expect(mockSdk.reloadFile).toHaveBeenCalled();
    await deps.jumpToPage(3);
    expect(mockSdk.jumpToPage).toHaveBeenCalledWith(3);
    expect(deps.toEmr({x: 5, y: 6}, size)).toEqual({x: 1, y: 2});
    expect(mockSdk.androidPoint2Emr).toHaveBeenCalledWith({x: 5, y: 6}, size);
    expect(deps.maxX(size)).toBe(21632);
    expect(deps.maxY(size)).toBe(16224);
    // The same bindings go to writeToNote.
    await exportPage(tree);
    expect(mockWriteToNote.mock.calls[0][2]).toBe(deps);
  });
});

describe('PilotChatScreen — after inserting', () => {
  const insert = async (tree: ReactTestRenderer) => {
    await press(tree, 'pilotchat-close');
    await press(tree, 'pilotchat-insert');
    await exportPage(tree);
  };

  it('closes onto a page still holding the conversation, ready to go on', async () => {
    const tree = await render();
    await ask(tree);
    await insert(tree);
    expect(mockClosePluginView).toHaveBeenCalledTimes(1);
    expect(has(tree, 'pilotchat-insert-prompt')).toBe(false);
    expect(page(tree).props.inkEnabled).toBe(true);
    expect(status(tree)).toBe('Inserted into your note.');
    expect(mockClearPage).not.toHaveBeenCalled();
    await ask(tree);
    expect(mockAskPilotChat.mock.calls[1][0].history).toHaveLength(2);
  });

  it('closes straight away when nothing was written since', async () => {
    const tree = await render();
    await ask(tree);
    await insert(tree);
    await press(tree, 'pilotchat-close');
    expect(mockClosePluginView).toHaveBeenCalledTimes(2);
    expect(has(tree, 'pilotchat-insert-prompt')).toBe(false);
  });

  it('inserting again replaces the earlier copy, in its place', async () => {
    const tree = await render();
    await ask(tree);
    await insert(tree);
    await ask(tree);
    await press(tree, 'pilotchat-close');
    expect(
      tree.root
        .findByProps({testID: 'pilotchat-insert-prompt'})
        .findAllByType(Text)
        .some(t => String(t.props.children).startsWith('It replaces the copy')),
    ).toBe(true);
    await press(tree, 'pilotchat-insert');
    await exportPage(tree);
    const pages = layoutForNote(
      PAYLOAD,
      TARGET.pageSize,
      headerDate(new Date()),
    );
    expect(mockRemoveInsertion).toHaveBeenCalledWith(
      {
        notePath: TARGET.notePath,
        firstPage: TARGET.page + 1,
        pages: signaturesOf(pages),
      },
      expect.anything(),
    );
    expect(mockWriteToNote.mock.calls[1][1]).toEqual({
      ...TARGET,
      page: TARGET.page,
    });
  });

  it('writes the new copy where the earlier one was, even from another page', async () => {
    const tree = await render();
    await ask(tree);
    await insert(tree);
    mockResolveNoteTarget.mockResolvedValue({...TARGET, page: 9});
    await ask(tree);
    await insert(tree);
    expect(mockWriteToNote.mock.calls[1][1]).toEqual({
      ...TARGET,
      page: TARGET.page,
    });
  });

  it('keeps an earlier copy the user has changed, and adds the new one', async () => {
    mockRemoveInsertion.mockResolvedValue({
      removed: false,
      why: 'page 3 has 9 strokes, 8 written',
    });
    const tree = await render();
    await ask(tree);
    await insert(tree);
    mockResolveNoteTarget.mockResolvedValue({...TARGET, page: 9});
    await ask(tree);
    await insert(tree);
    expect(mockWriteToNote.mock.calls[1][1]).toEqual({...TARGET, page: 9});
    // The new copy is the one a later Insert replaces.
    await ask(tree);
    await insert(tree);
    expect(mockRemoveInsertion.mock.calls[1][0].firstPage).toBe(10);
  });

  it('leaves a copy in another note alone', async () => {
    const tree = await render();
    await ask(tree);
    await insert(tree);
    mockResolveNoteTarget.mockResolvedValue({
      ...TARGET,
      notePath: '/other.note',
    });
    await ask(tree);
    await insert(tree);
    expect(mockRemoveInsertion).not.toHaveBeenCalled();
    expect(mockWriteToNote.mock.calls[1][1].notePath).toBe('/other.note');
  });

  it('forgets the copy on New, so the next conversation is inserted afresh', async () => {
    const tree = await render();
    await ask(tree);
    await insert(tree);
    await ask(tree);
    await press(tree, 'pilotchat-new');
    await press(tree, 'pilotchat-discard');
    await ask(tree);
    await insert(tree);
    expect(mockRemoveInsertion).not.toHaveBeenCalled();
  });

  it('reports a failed removal and forgets the copy', async () => {
    mockRemoveInsertion.mockRejectedValue(
      new NoteWriteError('removeNotePage failed'),
    );
    const tree = await render();
    await ask(tree);
    await insert(tree);
    await ask(tree);
    await insert(tree);
    expect(status(tree)).toBe(
      "Couldn't write into the note: removeNotePage failed",
    );
    await insert(tree);
    expect(mockRemoveInsertion).toHaveBeenCalledTimes(1);
  });
});

describe('PilotChatScreen — without a key it can use', () => {
  it.each([
    ['no key is set up', {kind: 'no-key'}, NEEDS_KEY],
    ['the keys are locked', {kind: 'locked'}, NEEDS_UNLOCK],
    [
      'new key files wait to be set up',
      {kind: 'merge', vaultExists: true, plaintextFiles: [KEY]},
      NEEDS_KEY_SETUP,
    ],
    [
      'the provider cannot see images',
      {
        kind: 'plaintext',
        files: [{...KEY, provider: 'deepseek', model: 'deepseek-chat'}],
      },
      NEEDS_VISION,
    ],
  ] as Array<[string, AppState, string]>)(
    'shows no writing page when %s, only what to do',
    async (_why, next, message) => {
      mockState = next;
      const tree = await render();
      expect(has(tree, 'pilotchat-page')).toBe(false);
      expect(
        tree.root.findByProps({testID: 'pilotchat-unavailable'}).props.children,
      ).toBe(message);
      expect(has(tree, 'pilotchat-ask')).toBe(false);
      await press(tree, 'pilotchat-close');
      expect(mockClosePluginView).toHaveBeenCalledTimes(1);
    },
  );

  it('shows no writing page until the keys are known', async () => {
    mockState = null;
    const tree = await render();
    expect(has(tree, 'pilotchat-page')).toBe(false);
    expect(has(tree, 'pilotchat-unavailable')).toBe(false);
    expect(status(tree)).toBe('Opening…');
  });

  it('looks at the keys again each time PilotChat is opened', async () => {
    mockState = {kind: 'no-key'};
    await render();
    act(() => mockButtonSubscriber?.({id: 100}));
    expect(mockRefresh).not.toHaveBeenCalled();
    act(() => mockButtonSubscriber?.({id: 400}));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('ignores a failed look at the keys', async () => {
    mockRefresh.mockRejectedValueOnce(new Error('io'));
    await render();
    await act(async () => mockButtonSubscriber?.({id: 400}));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('shows the writing page once a key is set up', async () => {
    mockState = {kind: 'no-key'};
    const tree = await render();
    await keysBecome(tree, {kind: 'plaintext', files: [KEY]});
    expect(has(tree, 'pilotchat-page')).toBe(true);
    expect(has(tree, 'pilotchat-unavailable')).toBe(false);
  });
});
