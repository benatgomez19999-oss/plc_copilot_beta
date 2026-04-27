#!/usr/bin/env node
import { main } from './cli.js';

// Bin entry. TypeScript preserves the shebang line above into `dist/index.js`
// during `tsc -p tsconfig.build.json`. The `bin` mapping in package.json
// points the `plccopilot` command at the emitted `dist/index.js`.
main(process.argv.slice(2)).then(
  (code) => {
    process.exit(code);
  },
  (err: unknown) => {
    // Safety net — `main()` already converts thrown errors into exit codes.
    // If something escaped (e.g., a synchronous throw outside `try`), surface
    // it on stderr instead of crashing silently.
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  },
);
