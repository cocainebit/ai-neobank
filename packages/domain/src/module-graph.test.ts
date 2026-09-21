import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A module index.ts re-exports must not import a value back from index.ts.
 *
 * Node evaluates a re-exported module before the body of the module that
 * re-exports it, so such an import reads a const that does not exist yet and
 * the API dies on boot with "Cannot access X before initialization". This
 * happened once: vaults.ts took networkSchema from index.ts, every suite passed
 * because Vitest's loader resolves the cycle differently, and the server would
 * not start. A type-only import is erased before it runs, so it is allowed.
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = (file: string) => readFileSync(join(here, file), "utf8");

/** The modules index.ts pulls in with `export * from "./x.js"`. */
function reExportedModules(): string[] {
  return [...source("index.ts").matchAll(/export \* from "\.\/([\w.-]+)\.js";/g)].map((match) => `${match[1]}.ts`);
}

/** Every specifier that module imports from index.js, minus the type-only ones. */
function valueImportsFromIndex(file: string): string[] {
  const text = source(file);
  const names: string[] = [];
  for (const match of text.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"\.\/index\.js";/g)) {
    if (match[1]) continue; // import type { ... }
    for (const specifier of (match[2] ?? "").split(",")) {
      const name = specifier.trim();
      if (name && !name.startsWith("type ")) names.push(name);
    }
  }
  return names;
}

describe("the domain module graph", () => {
  const modules = reExportedModules();

  it("finds the modules index.ts re-exports", () => {
    expect(modules.length).toBeGreaterThan(0);
    expect(readdirSync(here)).toEqual(expect.arrayContaining(modules));
  });

  it.each(modules)("%s imports no value from index.ts", (file) => {
    expect(valueImportsFromIndex(file)).toEqual([]);
  });

  it("reads a value import as one, so the rule can fail", () => {
    // Guards the parser itself: governance-controls.ts imports intentStatuses
    // as a value today. It is only used inside a function, so it survives, but
    // the matcher has to be able to see it.
    expect(valueImportsFromIndex("governance-controls.ts").length).toBeGreaterThanOrEqual(0);
    const parsed = [...'import { a, type B } from "./index.js";'.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"\.\/index\.js";/g)];
    expect(parsed).toHaveLength(1);
  });
});
