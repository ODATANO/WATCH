"use strict";

// CAP Plugin entry point for @odatano/watch
// This file is loaded automatically by CAP during startup

// Import and register the plugin logic. Path follows the in-place build:
// `tsconfig.build.json` (outDir ".") emits `src/plugin.ts` → `src/plugin.js`
// at the package root.
require('./src/plugin');
