// Resolves a ProviderClient + apiKey + model from the optional
// KeyFile. With a key file present we use the real provider client
// for the configured provider; without one we fall back to the
// fakeProvider so the UI stays interactive in offline / no-key mode.

import {useMemo} from 'react';
import fakeProvider from '../providers/fakeProvider';
import {createProviderClient} from '../providers';
import type {ProviderClient} from '../providers/ProviderClient';
import type {KeyFile} from '../types';

const FAKE_API_KEY = 'fake';
const FAKE_MODEL = 'fake-model-1';

export type ResolvedProvider = {
  client: ProviderClient;
  apiKey: string;
  model: string;
};

export const useProviderClient = (
  keyFile: KeyFile | undefined,
): ResolvedProvider =>
  useMemo<ResolvedProvider>(() => {
    if (keyFile) {
      return {
        client: createProviderClient(keyFile.provider),
        apiKey: keyFile.key,
        model: keyFile.model,
      };
    }
    return {client: fakeProvider, apiKey: FAKE_API_KEY, model: FAKE_MODEL};
  }, [keyFile]);
