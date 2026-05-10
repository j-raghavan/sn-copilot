/**
 * Typed wrapper around the native overlay TurboModule.
 *
 * The native module lives in
 * android/app/src/main/java/com/sncopilot/overlay/CopilotOverlayModule.kt.
 * Every call resolves (never rejects) with `{success, code, message}`
 * so the caller can branch deterministically on `code` without
 * try/catch noise. Tests mock `NativeModules.CopilotOverlay`.
 */
import {NativeModules} from 'react-native';

export type OverlayResultCode =
  | 'OK'
  | 'NO_ACTIVITY'
  | 'ADD_VIEW_FAILED'
  | 'NOT_OPEN'
  | 'UPDATE_FAILED'
  | 'NO_CLIPBOARD_SERVICE'
  | 'CLIPBOARD_THREW'
  | 'PARENT_MISSING'
  | 'BAD_BASE64'
  | 'WRITE_FAILED'
  | 'MODULE_MISSING';

export type OverlayResult = {
  success: boolean;
  code: OverlayResultCode;
  message: string;
};

export type ScreenSize = {
  success: boolean;
  width: number;
  height: number;
  message: string;
};

type NativeShape = {
  open(width: number, height: number, x: number, y: number): Promise<OverlayResult>;
  move(x: number, y: number): Promise<OverlayResult>;
  redraw(): Promise<OverlayResult>;
  close(): Promise<OverlayResult>;
  getScreenSize(): Promise<ScreenSize>;
  copyToClipboard(text: string, label: string | null): Promise<OverlayResult>;
  writeFileBase64(path: string, base64Content: string): Promise<OverlayResult>;
};

const moduleMissingResult: OverlayResult = {
  success: false,
  code: 'MODULE_MISSING',
  message:
    'NativeModules.CopilotOverlay is undefined. Either the native module ' +
    'failed to register (check buildPlugin.sh detected ' +
    'CopilotOverlayPackage in MainApplication.kt and ran the gradle ' +
    'native build) or the JS bundle is running in a host that does not ' +
    'expose this module.',
};

const moduleMissingScreenSize: ScreenSize = {
  success: false,
  width: 0,
  height: 0,
  message: moduleMissingResult.message,
};

function nativeOrNull(): NativeShape | null {
  const m = (NativeModules as Record<string, unknown>).CopilotOverlay;
  return (m as NativeShape | undefined) ?? null;
}

export async function open(
  width: number,
  height: number,
  x: number,
  y: number,
): Promise<OverlayResult> {
  const native = nativeOrNull();
  if (!native) {
    return moduleMissingResult;
  }
  return native.open(width, height, x, y);
}

export async function move(x: number, y: number): Promise<OverlayResult> {
  const native = nativeOrNull();
  if (!native) {
    return moduleMissingResult;
  }
  return native.move(x, y);
}

export async function redraw(): Promise<OverlayResult> {
  const native = nativeOrNull();
  if (!native) {
    return moduleMissingResult;
  }
  return native.redraw();
}

export async function close(): Promise<OverlayResult> {
  const native = nativeOrNull();
  if (!native) {
    return moduleMissingResult;
  }
  return native.close();
}

export async function getScreenSize(): Promise<ScreenSize> {
  const native = nativeOrNull();
  if (!native) {
    return moduleMissingScreenSize;
  }
  return native.getScreenSize();
}

export async function copyToClipboard(
  text: string,
  label: string | null = null,
): Promise<OverlayResult> {
  const native = nativeOrNull();
  if (!native) {
    return moduleMissingResult;
  }
  return native.copyToClipboard(text, label);
}

export async function writeFileBase64(
  path: string,
  base64Content: string,
): Promise<OverlayResult> {
  const native = nativeOrNull();
  if (!native) {
    return moduleMissingResult;
  }
  return native.writeFileBase64(path, base64Content);
}

// Convenience for tests / future callers that prefer a single object.
const CopilotOverlay = {
  open,
  move,
  redraw,
  close,
  getScreenSize,
  copyToClipboard,
  writeFileBase64,
};
export default CopilotOverlay;
