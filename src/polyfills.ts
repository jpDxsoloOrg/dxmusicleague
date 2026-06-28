// Browser polyfills required by amazon-cognito-identity-js, which expects a
// Node-style `Buffer` global (and `global`). This module is imported FIRST in
// main.tsx so it runs before the Cognito SDK's module graph evaluates —
// otherwise the SDK throws "Buffer is not defined" at load and blanks the app.
// (`global` is handled at build time by `define` in vite.config.ts.)

import { Buffer } from "buffer";

if (!(globalThis as { Buffer?: unknown }).Buffer) {
  (globalThis as { Buffer?: unknown }).Buffer = Buffer;
}
