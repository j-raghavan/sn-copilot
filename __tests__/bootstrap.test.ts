/**
 * Tests for the JS-side bootstrap in index.js. Pins:
 *   1. AppRegistry registers both the App component and the
 *      SnCopilotPanel overlay component.
 *   2. PluginManager.init runs and the plugin router is installed.
 *   3. Sidebar button is registered with the expected scopes + id.
 *   4. On a sidebar press: capture is fired-and-forget, the resulting
 *      promise is handed to setPageContextPromise, and the overlay
 *      opens with geometry computed from the live screen size.
 *   5. Non-sidebar press events are ignored.
 *   6. Bad screen size falls back to the documented default
 *      (1404x1872, the 7.8" portrait baseline).
 *   7. Failures from CopilotOverlay.open and captureCurrentPage are
 *      logged but do not crash the bootstrap.
 *   8. The scratch-orphan sweep fires at bootstrap and the capture
 *      deps carry a deleteFile bridge.
 */

const registerButtonListenerCalls: Array<{
  onButtonPress: (e: ButtonEventLike) => void;
}> = [];
const mockInit = jest.fn();
const mockRegisterButton = jest.fn();
const mockGetPluginDirPath = jest.fn(async () => '/sd/copilot');

type ButtonEventLike = {
  pressEvent: number;
  id: number;
  name: string;
  icon: string;
  color: number;
  bgColor: number;
};

jest.mock('sn-plugin-lib', () => ({
  PluginManager: {
    init: () => mockInit(),
    registerButtonListener: (handler: {
      onButtonPress: (e: ButtonEventLike) => void;
    }) => {
      registerButtonListenerCalls.push(handler);
    },
    registerButton: (
      type: number,
      scopes: string[],
      opts: Record<string, unknown>,
    ) => mockRegisterButton(type, scopes, opts),
    getPluginDirPath: () => mockGetPluginDirPath(),
  },
  PluginCommAPI: {},
  PluginFileAPI: {},
  PluginDocAPI: {},
  FileUtils: {
    exists: jest.fn(async () => false),
    listFiles: jest.fn(async () => null),
    deleteFile: jest.fn(async () => true),
  },
}));

const mockOpen = jest.fn();
const mockGetScreenSize = jest.fn();
const mockCleanupOldVersions = jest.fn(async (..._args: unknown[]) => ({
  success: true,
  freedBytes: 0,
  kept: 'none',
}));

jest.mock('../src/native/CopilotOverlay', () => {
  const {
    cryptoPbkdf2Sha256MockImpl,
    cryptoRandomBytesMockImpl,
  } = require('./helpers/cryptoMockImpl');
  return {
    __esModule: true,
    default: {
      open: (w: number, h: number, x: number, y: number) =>
        mockOpen(w, h, x, y),
      getScreenSize: () => mockGetScreenSize(),
      close: jest.fn(),
      copyToClipboard: jest.fn(),
      // index.js's secure-lifecycle install touches the crypto bridge
      // through buildWiringBundle → readPrefs (which doesn't actually
      // call crypto, but the wiring bundle constructs CopilotOverlay
      // refs eagerly). Provide working impls so a future test that
      // exercises a real secure flow doesn't have to add the mock.
      writeFileBase64: jest.fn(async () => ({success: true, code: 'OK', message: ''})),
      cryptoPbkdf2Sha256: jest.fn(cryptoPbkdf2Sha256MockImpl),
      cryptoRandomBytes: jest.fn(cryptoRandomBytesMockImpl),
      cleanupOldVersions: (...args: unknown[]) =>
        mockCleanupOldVersions(...args),
    },
  };
});

const mockCaptureCurrentPage = jest.fn();
const mockSweepScratchOrphans = jest.fn(
  async (..._args: unknown[]) => 0,
);
jest.mock('../src/scope/captureScreenshot', () => ({
  captureCurrentPage: (...args: unknown[]) => mockCaptureCurrentPage(...args),
  sweepScratchOrphans: (...args: unknown[]) =>
    mockSweepScratchOrphans(...args),
}));

const mockSetPageContextPromise = jest.fn();
jest.mock('../src/scope/pageContext', () => {
  const actual = jest.requireActual('../src/scope/pageContext');
  return {
    ...actual,
    setPageContextPromise: (p: unknown) => mockSetPageContextPromise(p),
  };
});

import {AppRegistry} from 'react-native';

const okEvent = (id: number): ButtonEventLike => ({
  id,
  pressEvent: 3,
  name: '',
  icon: '',
  color: 0,
  bgColor: 0,
});

const drainMicrotasks = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
  }
};

describe('index.js bootstrap', () => {
  let registerSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    registerButtonListenerCalls.length = 0;
    mockInit.mockClear();
    mockRegisterButton.mockClear();
    mockOpen.mockReset();
    mockOpen.mockResolvedValue({
      success: true,
      code: 'OK',
      message: 'fixture',
    });
    mockGetScreenSize.mockReset();
    mockGetScreenSize.mockResolvedValue({
      success: true,
      width: 1000,
      height: 2000,
      message: 'fixture',
    });
    mockCaptureCurrentPage.mockReset();
    mockCaptureCurrentPage.mockResolvedValue(null);
    mockCleanupOldVersions.mockClear();
    mockSweepScratchOrphans.mockClear();
    mockSetPageContextPromise.mockClear();
    const {__testing__} = require('../src/pluginRouter');
    __testing__.reset();
    registerSpy = jest
      .spyOn(AppRegistry, 'registerComponent')
      .mockImplementation(() => 'noop' as unknown as string);
  });

  afterEach(() => {
    registerSpy.mockRestore();
  });

  const importBootstrap = (): void => {
    require('../index.js');
  };

  it('runs the old-version janitor at bootstrap with the plugin dir', async () => {
    importBootstrap();
    await drainMicrotasks();
    expect(mockCleanupOldVersions).toHaveBeenCalledWith('/sd/copilot');
  });

  it('bootstrap survives a janitor failure', async () => {
    mockCleanupOldVersions.mockRejectedValueOnce(new Error('sweep boom'));
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      importBootstrap();
      await drainMicrotasks();
      expect(mockInit).toHaveBeenCalledTimes(1);
      expect(
        log.mock.calls.some(c => c.join(' ').includes('janitor failed')),
      ).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it('fires the scratch-orphan sweep at bootstrap with wired file bridges', async () => {
    importBootstrap();
    await drainMicrotasks();
    expect(mockSweepScratchOrphans).toHaveBeenCalledTimes(1);
    const deps = mockSweepScratchOrphans.mock.calls[0][0] as {
      manager: unknown;
      listFiles: unknown;
      deleteFile: unknown;
    };
    expect(deps.manager).toBeDefined();
    // Invoke the bridges rather than only type-checking them: these
    // thin lambdas are the whole wiring, and a wrong FileUtils method
    // name here fails only at runtime on device.
    const {FileUtils} = jest.requireMock('sn-plugin-lib') as {
      FileUtils: {
        listFiles: jest.Mock;
        deleteFile: jest.Mock;
      };
    };
    await (deps.listFiles as (p: string) => Promise<unknown>)('/plugin/dir');
    expect(FileUtils.listFiles).toHaveBeenCalledWith('/plugin/dir');
    await (deps.deleteFile as (p: string) => Promise<unknown>)('/plugin/x.png');
    expect(FileUtils.deleteFile).toHaveBeenCalledWith('/plugin/x.png');
  });

  it('bootstrap survives a scratch-sweep failure', async () => {
    mockSweepScratchOrphans.mockRejectedValueOnce(new Error('sweep boom'));
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      importBootstrap();
      await drainMicrotasks();
      expect(mockInit).toHaveBeenCalledTimes(1);
      expect(
        log.mock.calls.some(c => c.join(' ').includes('scratch sweep failed')),
      ).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it('passes a deleteFile bridge into the sidebar capture deps', async () => {
    importBootstrap();
    registerButtonListenerCalls[0].onButtonPress(okEvent(100)); // sidebar id
    await drainMicrotasks();
    const deps = mockCaptureCurrentPage.mock.calls[0][0] as {
      deleteFile?: unknown;
    };
    const {FileUtils} = jest.requireMock('sn-plugin-lib') as {
      FileUtils: {deleteFile: jest.Mock};
    };
    await (deps.deleteFile as (p: string) => Promise<unknown>)(
      '/plugin/scratch.png',
    );
    expect(FileUtils.deleteFile).toHaveBeenCalledWith('/plugin/scratch.png');
  });

  it('registers App + SnCopilotPanel components and inits the plugin manager', () => {
    importBootstrap();
    const names = registerSpy.mock.calls.map(c => c[0]);
    expect(names).toContain('SnCopilot');
    expect(names).toContain('SnCopilotPanel');
    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(registerButtonListenerCalls).toHaveLength(1);
  });

  it('registers the sidebar button with the expected scopes and id', () => {
    importBootstrap();
    expect(mockRegisterButton).toHaveBeenCalledTimes(1);
    const [type, scopes, opts] = mockRegisterButton.mock.calls[0];
    expect(type).toBe(1);
    expect(scopes).toEqual(['NOTE', 'DOC']);
    expect((opts as {id: number}).id).toBe(100);
    expect((opts as {showType: number}).showType).toBe(0);
  });

  it('on sidebar press: captures page, hands promise to pageContext, opens overlay with computed geometry', async () => {
    // Drive the consoleLogger arrows that the bootstrap passes into
    // captureCurrentPage so they show up as covered (the real
    // capture exercises both log + warn paths during a normal flow).
    mockCaptureCurrentPage.mockImplementationOnce(async (deps: unknown) => {
      const d = deps as {logger: {log: (m: string) => void; warn: (m: string) => void}};
      d.logger.log('captured');
      d.logger.warn('captured');
      return null;
    });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      importBootstrap();
      const handler = registerButtonListenerCalls[0];
      handler.onButtonPress(okEvent(100));
      await drainMicrotasks();
      expect(mockCaptureCurrentPage).toHaveBeenCalledTimes(1);
      expect(mockSetPageContextPromise).toHaveBeenCalledTimes(1);
      expect(mockGetScreenSize).toHaveBeenCalledTimes(1);
      expect(mockOpen).toHaveBeenCalledTimes(1);
      const [w, h, x, y] = mockOpen.mock.calls[0];
      expect(w).toBe(Math.round(1000 * 0.55));
      expect(h).toBe(Math.round(2000 * 0.85));
      expect(x).toBe(1000 - Math.round(1000 * 0.55));
      expect(y).toBe(Math.round((2000 - Math.round(2000 * 0.85)) / 2));
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it('non-sidebar press events are ignored', async () => {
    importBootstrap();
    const handler = registerButtonListenerCalls[0];
    handler.onButtonPress(okEvent(999));
    await drainMicrotasks();
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockCaptureCurrentPage).not.toHaveBeenCalled();
  });

  it('falls back to the documented screen size when getScreenSize reports failure', async () => {
    mockGetScreenSize.mockResolvedValueOnce({
      success: false,
      width: 0,
      height: 0,
      message: 'no display',
    });
    importBootstrap();
    const handler = registerButtonListenerCalls[0];
    handler.onButtonPress(okEvent(100));
    await drainMicrotasks();
    const [w] = mockOpen.mock.calls[0];
    expect(w).toBe(Math.round(1404 * 0.55));
  });

  it('logs and continues when CopilotOverlay.open rejects', async () => {
    mockOpen.mockRejectedValueOnce(new Error('open boom'));
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      importBootstrap();
      const handler = registerButtonListenerCalls[0];
      handler.onButtonPress(okEvent(100));
      await drainMicrotasks();
      const lines = log.mock.calls.map(c => c.join(' '));
      expect(lines.some(l => l.includes('CopilotOverlay.open threw'))).toBe(
        true,
      );
    } finally {
      log.mockRestore();
    }
  });

  it('logs and continues when captureCurrentPage rejects', async () => {
    mockCaptureCurrentPage.mockRejectedValueOnce(new Error('capture boom'));
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      importBootstrap();
      const handler = registerButtonListenerCalls[0];
      handler.onButtonPress(okEvent(100));
      await drainMicrotasks();
      const lines = log.mock.calls.map(c => c.join(' '));
      expect(lines.some(l => l.includes('captureCurrentPage threw'))).toBe(
        true,
      );
      // Bootstrap should still attempt to open the overlay.
      expect(mockOpen).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
