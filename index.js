import {AppRegistry, Image} from 'react-native';
import App from './App';
import CopilotPanel from './src/ui/CopilotPanel';
import {name as appName} from './app.json';
import {
  PluginManager,
  PluginCommAPI,
  PluginFileAPI,
  PluginDocAPI,
} from 'sn-plugin-lib';
import {
  installPluginRouter,
  subscribeToButtonEvents,
  BUTTON_ID_SIDEBAR,
  BUTTON_TYPE_SIDEBAR,
} from './src/pluginRouter';
import CopilotOverlay from './src/native/CopilotOverlay';
import {debugLog} from './src/diagnostics/log';
import {captureCurrentPage} from './src/scope/captureScreenshot';
import {setPageContextPromise} from './src/scope/pageContext';

// showType: 0 ("No UI display needed"). showType:1 would open the
// plugin view full-screen and trigger `sendFullScreenDisableArea`,
// killing the partial-overlay UX. With showType:0 the host fires
// the click event into our JS context without opening any plugin
// view, and we draw our own overlay via the native TurboModule.
const SHOW_TYPE_HEADLESS = 0;

// Localized button name as JSON, per the SDK's i18n convention.
const localizedName = () =>
  JSON.stringify({
    en: 'Copilot',
    zh_CN: '助手',
    zh_TW: '助手',
    ja: 'コパイロット',
    de: 'Copilot',
  });

// Right-docked panel geometry. Computed at runtime from the actual
// screen dimensions (Android `Display.getRealSize`) so the same code
// works across 7.8" / 10.3" panels in either orientation without a
// device table.
//
//   width  = 55% of screen width
//   height = 85% of screen height (vertically centred, leaving a
//            visible page strip above and below so the overlay reads
//            as a bordered popup rather than a hard-docked sidebar)
const PANEL_WIDTH_RATIO = 0.55;
const PANEL_HEIGHT_RATIO = 0.85;

// Fallback when getScreenSize() fails. 7.8" portrait is the most
// common Supernote form factor.
const FALLBACK_SCREEN_WIDTH = 1404;
const FALLBACK_SCREEN_HEIGHT = 1872;

const computeDockGeometry = (screenWidth, screenHeight) => {
  const overlayWidth = Math.round(screenWidth * PANEL_WIDTH_RATIO);
  const overlayHeight = Math.round(screenHeight * PANEL_HEIGHT_RATIO);
  return {
    width: overlayWidth,
    height: overlayHeight,
    x: screenWidth - overlayWidth,
    y: Math.round((screenHeight - overlayHeight) / 2),
  };
};

// We register only the sidebar button. The page-screenshot context
// captured at button-tap time covers the use cases the lasso and
// DOC-selection buttons would have addressed, with a simpler UX.
const SCOPE_LABEL_FOR_SIDEBAR = 'Current Page';

AppRegistry.registerComponent(appName, () => App);

// React component our native overlay mounts via
// `ReactRootView.startReactApplication`. The component-name string
// MUST match `REACT_OVERLAY_COMPONENT` in CopilotOverlayModule.kt.
AppRegistry.registerComponent('SnCopilotPanel', () => CopilotPanel);

PluginManager.init();
installPluginRouter();

// Route the sidebar button click into the native overlay.
// Subscribing here (rather than installing a second listener) keeps
// the single-listener contract in src/pluginRouter.ts.
subscribeToButtonEvents(async event => {
  if (event.id !== BUTTON_ID_SIDEBAR) {
    return;
  }
  debugLog(
    `[COPILOT] sidebar pressed; scope=${SCOPE_LABEL_FOR_SIDEBAR}`,
  );

  // Fire-and-forget capture. The promise is handed to the
  // pageContext singleton and we proceed immediately so the popup
  // opens without waiting for screenshot + OCR (700-2000 ms on
  // device). ChatView awaits the resolved value when it needs the
  // image/text; by then capture is usually done, and the "thinking"
  // placeholder absorbs any residual wait. The .catch is belt-and-
  // suspenders — captureCurrentPage already returns null on
  // internal errors.
  // logger.log lines from captureCurrentPage carry the notePath and
  // byte counts, so route them through debugLog (no-op in release).
  // logger.warn stays on console.warn — those are actionable signals.
  const consoleLogger = {
    log: msg => debugLog(msg),
    warn: msg => console.warn(msg),
  };
  const capturePromise = captureCurrentPage({
    comm: PluginCommAPI,
    file: PluginFileAPI,
    doc: PluginDocAPI,
    manager: PluginManager,
    logger: consoleLogger,
  }).catch(e => {
    console.log('[COPILOT] captureCurrentPage threw', String(e));
    return null;
  });
  setPageContextPromise(capturePromise);

  const screen = await CopilotOverlay.getScreenSize();
  let screenWidth;
  let screenHeight;
  if (screen.success && screen.width > 0 && screen.height > 0) {
    screenWidth = screen.width;
    screenHeight = screen.height;
  } else {
    screenWidth = FALLBACK_SCREEN_WIDTH;
    screenHeight = FALLBACK_SCREEN_HEIGHT;
    console.log(
      '[COPILOT] screen size lookup failed, using fallback ' +
        `${FALLBACK_SCREEN_WIDTH}x${FALLBACK_SCREEN_HEIGHT}`,
      JSON.stringify(screen),
    );
  }

  const geometry = computeDockGeometry(screenWidth, screenHeight);

  try {
    const result = await CopilotOverlay.open(
      geometry.width,
      geometry.height,
      geometry.x,
      geometry.y,
    );
    debugLog('[COPILOT] CopilotOverlay.open result', JSON.stringify(result));
  } catch (err) {
    console.log('[COPILOT] CopilotOverlay.open threw', String(err));
  }
});

PluginManager.registerButton(BUTTON_TYPE_SIDEBAR, ['NOTE', 'DOC'], {
  id: BUTTON_ID_SIDEBAR,
  name: localizedName(),
  icon: Image.resolveAssetSource(require('./assets/copilot_icon.png')).uri,
  showType: SHOW_TYPE_HEADLESS,
});
