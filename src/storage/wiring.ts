// Production wiring for the secure-key-store hooks. Centralizes the
// "build the deps bundle from sn-plugin-lib + the overlay native
// module" boilerplate so CopilotPanel and SettingsView can share it
// instead of duplicating.

import {FileUtils, PluginManager} from 'sn-plugin-lib';
import CopilotOverlay from '../native/CopilotOverlay';
import {createBridgeFileIo, type FileIo} from './fileIo';
import {resolveVaultPaths} from './vaultPath';
import type {FileUtilsLike} from './keyFiles';
import type {Logger} from '../sdk/types';
import type {ConversationsDeps} from './conversations';
import {getDerivedKey} from './derivedKey';
import {readPrefs, type PrefsDeps} from './prefs';

export type WiringBundle = {
  io: FileIo;
  vaultDeps: {io: FileIo; vaultPath: string; logger: Logger};
  // Reuse PrefsDeps so the optional-logger contract aligns with what
  // readPrefs / writePrefs actually expect. The wiring still provides
  // a real logger at construction time — this is just type honesty.
  prefsDeps: PrefsDeps;
  discoveryDeps: {fileUtils: FileUtilsLike; logger: Logger};
  conversationsDeps: ConversationsDeps;
};

const consoleLogger: Logger = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

const fileUtilsLike = (): FileUtilsLike => FileUtils as unknown as FileUtilsLike;

const buildBridgeIo = (): FileIo =>
  createBridgeFileIo({
    exists: (p) => fileUtilsLike().exists(p),
    deleteFile: (p) =>
      (FileUtils as unknown as {deleteFile: (path: string) => Promise<boolean>}).deleteFile(p),
    renameToFile: (s, d) =>
      (FileUtils as unknown as {renameToFile: (s: string, d: string) => Promise<boolean>}).renameToFile(s, d),
    fetchFn: globalThis.fetch.bind(globalThis),
    writeFileBase64: (path, b64) => CopilotOverlay.writeFileBase64(path, b64),
  });

export const buildWiringBundle = async (): Promise<WiringBundle> => {
  const r = await resolveVaultPaths(() => PluginManager.getPluginDirPath());
  const io = buildBridgeIo();
  const prefsDeps: PrefsDeps = {io, prefsPath: r.prefsPath, logger: consoleLogger};
  const conversationsDeps: ConversationsDeps = {
    io,
    conversationsPath: r.conversationsPath,
    encryptionMode: async () => (await readPrefs(prefsDeps)).encryptionMode,
    derivedKey: () => getDerivedKey(),
    logger: consoleLogger,
  };
  return {
    io,
    vaultDeps: {io, vaultPath: r.vaultPath, logger: consoleLogger},
    prefsDeps,
    discoveryDeps: {fileUtils: fileUtilsLike(), logger: consoleLogger},
    conversationsDeps,
  };
};
