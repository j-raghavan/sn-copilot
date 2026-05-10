module.exports = {
  preset: 'react-native',
  testPathIgnorePatterns: [
    '/node_modules/',
    '/__tests__/helpers/',
  ],
  // The RN jest preset only transforms react-native/@react-native
  // node_modules. @noble/* ships ESM-only with no CJS fallback, so it
  // needs babel transformation under jest. Keep the rest of the
  // preset's ignore intact.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@noble)/)',
  ],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    'index.js',
    '!src/**/index.ts',
    // Interface-only / pure-type modules — TS strips them at runtime
    // so istanbul reports 0/0 for everything. The contracts are
    // structurally enforced by the TS compiler at import sites.
    '!src/providers/ProviderClient.ts',
    '!src/sdk/types.ts',
  ],
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/__tests__/helpers/',
    '/build/',
    '/coverage/',
  ],
  coverageThreshold: {
    global: {
      statements: 97,
      branches: 97,
      functions: 97,
      lines: 97,
    },
  },
};
