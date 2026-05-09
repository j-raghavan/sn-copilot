module.exports = {
  preset: 'react-native',
  testPathIgnorePatterns: [
    '/node_modules/',
    '/__tests__/helpers/',
  ],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
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
