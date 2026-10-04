/**
 * Tests for src/native/PilotChatPageView — the JS face of the native PilotChat
 * page.
 *
 * Pins:
 *   1. The component is the native 'PilotChatPageView'.
 *   2. askNow dispatches 'ask' with no arguments to the mounted view.
 *   3. appendAnswer dispatches 'appendAnswer' with the text.
 *   4. appendNote dispatches 'appendNote' with the text.
 *   5. exportForNote dispatches 'exportForNote' with the font size, page height and
 *      text width.
 *   6. Before the view mounts (no node handle) nothing is dispatched.
 *   7. clearPage dispatches 'clearPage'.
 */
// Built inside the factory: the module under test calls
// requireNativeComponent at import, before test-scope consts exist.
jest.mock('react-native', () => ({
  findNodeHandle: jest.fn(),
  requireNativeComponent: jest.fn((name: string) => `native:${name}`),
  UIManager: {dispatchViewManagerCommand: jest.fn()},
}));

import {
  appendAnswer,
  appendNote,
  askNow,
  clearPage,
  PilotChatPageNativeView,
  exportForNote,
  scrollPage,
  type PilotChatPageRef,
} from '../src/native/PilotChatPageView';

const RN = jest.requireMock('react-native') as {
  findNodeHandle: jest.Mock;
  requireNativeComponent: jest.Mock;
  UIManager: {dispatchViewManagerCommand: jest.Mock};
};
const mockFindNodeHandle = RN.findNodeHandle;
const mockDispatch = RN.UIManager.dispatchViewManagerCommand;
const mockRequireNativeComponent = RN.requireNativeComponent;

const VIEW = {} as PilotChatPageRef;

beforeEach(() => {
  mockFindNodeHandle.mockReset();
  mockDispatch.mockReset();
});

describe('PilotChatPageView', () => {
  it('is the native PilotChatPageView component', () => {
    expect(mockRequireNativeComponent).toHaveBeenCalledWith(
      'PilotChatPageView',
    );
    expect(PilotChatPageNativeView).toBe('native:PilotChatPageView');
  });

  it('askNow dispatches "ask" to the mounted view', () => {
    mockFindNodeHandle.mockReturnValue(42);
    askNow(VIEW);
    expect(mockFindNodeHandle).toHaveBeenCalledWith(VIEW);
    expect(mockDispatch).toHaveBeenCalledWith(42, 'ask', []);
  });

  it('appendAnswer dispatches "appendAnswer" with the text', () => {
    mockFindNodeHandle.mockReturnValue(7);
    appendAnswer(VIEW, 'A qubit is both.');
    expect(mockDispatch).toHaveBeenCalledWith(7, 'appendAnswer', [
      'A qubit is both.',
    ]);
  });

  it('appendNote dispatches "appendNote" with the text', () => {
    mockFindNodeHandle.mockReturnValue(7);
    appendNote(VIEW, 'Try writing larger.');
    expect(mockDispatch).toHaveBeenCalledWith(7, 'appendNote', [
      'Try writing larger.',
    ]);
  });

  it('exportForNote dispatches "exportForNote" with the font size, width and page height', () => {
    mockFindNodeHandle.mockReturnValue(9);
    exportForNote(VIEW, 36, 1728, 2304);
    expect(mockDispatch).toHaveBeenCalledWith(
      9,
      'exportForNote',
      [36, 1728, 2304],
    );
  });

  it('clearPage dispatches "clearPage"', () => {
    mockFindNodeHandle.mockReturnValue(9);
    clearPage(VIEW);
    expect(mockDispatch).toHaveBeenCalledWith(9, 'clearPage', []);
  });

  it('scrollPage dispatches "scrollPage" with the direction', () => {
    mockFindNodeHandle.mockReturnValue(9);
    scrollPage(VIEW, -1);
    expect(mockDispatch).toHaveBeenCalledWith(9, 'scrollPage', [-1]);
  });

  it('dispatches nothing before the view mounts', () => {
    mockFindNodeHandle.mockReturnValue(null);
    askNow(null);
    appendAnswer(null, 'x');
    appendNote(null, 'x');
    exportForNote(null, 1, 1, 1);
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
