module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFilesAfterEnv: ['ts-node/register/transpile-only'],
  testMatch: ['**/test/**/*.test.ts', '**/test/**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Under tsconfig `moduleResolution: "node16"`, relative imports must include
  // `.js` extensions. The compiled-on-the-fly tests resolve those back to `.ts`
  // via this mapper — Jest's resolver uses the literal path, not TypeScript's.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  transformIgnorePatterns: ['/node_modules/'],
  globalSetup: '<rootDir>/test/jest-global-setup.js',
  collectCoverageFrom: [
    'src/**/*.ts',
    'srv/**/*.ts',
    '!src/**/*.d.ts',
    '!srv/**/*.d.ts',
    '!**/node_modules/**',
  ],
  coverageThreshold: {
    global: { branches: 50, functions: 50, lines: 50 },
  },
  openHandlesTimeout: 0,
};
