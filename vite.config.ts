import { defineConfig } from 'vite';
export default defineConfig({
  build: { outDir: 'dist/client' },
  plugins: [{
    name: 'enforce-server-only-game-logic',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        for (const id of Object.keys(output.modules)) {
          if (/\/src\/(core|server)\//.test(id.replaceAll('\\', '/'))) {
            throw new Error(`Server-only game module entered client bundle: ${id}`);
          }
        }
      }
    },
  }],
});
