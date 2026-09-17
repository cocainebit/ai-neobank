// Shared vitest config: resolve workspace packages to their sources so tests
// never run against a stale dist/. Each package re-exports this file.
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));

export default {
  resolve: {
    alias: [
      { find: /^@ai-neobank\/worker$/, replacement: `${root}apps/worker/src/worker.ts` },
      { find: /^@ai-neobank\/x402-adapter\/testing$/, replacement: `${root}packages/x402-adapter/src/testing.ts` },
      { find: /^@ai-neobank\/signer\/testing$/, replacement: `${root}packages/signer/src/testing.ts` },
      { find: /^@ai-neobank\/([a-z0-9-]+)$/, replacement: `${root}packages/$1/src/index.ts` }
    ]
  }
};
