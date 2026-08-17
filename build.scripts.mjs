import { build } from 'vite';

// Chrome refuses ES modules for content scripts, and MAIN-world injection needs
// a self-contained file. So each of these is bundled on its own as an IIFE.
const entries = [
  { name: 'background', input: 'src/background/index.js' },
  { name: 'content', input: 'src/content/index.js' },
  { name: 'inpage', input: 'src/inpage/index.js' },
];

for (const entry of entries) {
  await build({
    configFile: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      copyPublicDir: false,
      target: 'esnext',
      minify: false,
      lib: {
        entry: entry.input,
        formats: ['iife'],
        name: `adrix_${entry.name}`,
        fileName: () => `${entry.name}.js`,
      },
      rollupOptions: {
        output: { inlineDynamicImports: true, extend: true },
      },
    },
  });
  console.log(`built ${entry.name}.js`);
}
