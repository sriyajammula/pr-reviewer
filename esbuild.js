const esbuild = require('esbuild');

const isProd = process.argv.includes('--production');

esbuild.build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',            
  external: ['vscode'],    
  outfile: 'out/extension.js',
  sourcemap: !isProd,
}).then(() => {
  console.log('Build complete');
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
