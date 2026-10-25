import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'server/src/index.ts', 'migrate-cli': 'server/src/db/migrate-cli.ts', 'seed-cli': 'server/src/db/seed-cli.ts', 'create-admin-cli': 'server/src/db/create-admin-cli.ts' },
  outDir: 'dist/server',
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  clean: true,
  splitting: true,
  tsconfig: 'server/tsconfig.json',
  // Runtime packages stay external; workspace code (server + shared) is bundled.
  skipNodeModulesBundle: true,
});
