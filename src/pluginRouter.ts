/**
 * Single source of truth for plugin button press events.
 *
 * sn-plugin-lib only allows one `PluginManager.registerButtonListener`
 * at a time (last registration wins). This module installs exactly
 * one listener and fans out to subscribers so every feature can
 * subscribe without fighting over the registration. The "last event"
 * replay window mirrors sn-plugin-lib's 1-second cached
 * `lastButtonEventMsg`: a component mounting after the press still
 * receives the triggering event.
 */
import {PluginManager} from 'sn-plugin-lib';

export const BUTTON_ID_SIDEBAR = 100;
export const BUTTON_ID_LASSO_NOTE = 200;
export const BUTTON_ID_DOC_SELECT = 300;

// Type values come from sn-plugin-lib's NativePluginManager.d.ts.
export const BUTTON_TYPE_SIDEBAR = 1;
export const BUTTON_TYPE_LASSO_TOOLBAR = 2;
export const BUTTON_TYPE_DOC_SELECTION = 3;

// editDataTypes for lasso buttons (type=2 only). Stroke-only — mixing
// stroke and text editDataTypes hides the lasso button on every lasso.
export const EDIT_DATA_TYPE_STROKE = 0;

// Mirror sn-plugin-lib's ButtonEvent shape locally so we don't depend on
// the library's internal sub-path (which isn't exported in its package
// exports map). Kept in sync with
// node_modules/sn-plugin-lib/src/listener/ButtonListener.ts.
export type ButtonEvent = {
  pressEvent: number;
  id: number;
  name: string;
  color: number;
  icon: string;
  bgColor: number;
};

export type ButtonSubscriber = (event: ButtonEvent) => void;

let lastEvent: ButtonEvent | null = null;
const subscribers = new Set<ButtonSubscriber>();
let installed = false;

export function installPluginRouter(): void {
  if (installed) {
    return;
  }
  installed = true;
  PluginManager.registerButtonListener({
    onButtonPress(event: ButtonEvent) {
      console.log('[PLUGIN_ROUTER] onButtonPress', JSON.stringify(event));
      lastEvent = event;
      for (const fn of subscribers) {
        try {
          fn(event);
        } catch (e) {
          console.error('[PLUGIN_ROUTER] subscriber threw', e);
        }
      }
    },
  });
}

export function getLastButtonEvent(): ButtonEvent | null {
  return lastEvent;
}

export function subscribeToButtonEvents(fn: ButtonSubscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

// Test-only helpers. Jest resets modules between suites, but if a single
// test wants a clean slate without tearing down the whole module cache
// it can use these. NOT exported for production use.
export const __testing__ = {
  reset(): void {
    lastEvent = null;
    subscribers.clear();
    installed = false;
  },
  getSubscriberCount(): number {
    return subscribers.size;
  },
  isInstalled(): boolean {
    return installed;
  },
};
