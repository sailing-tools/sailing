// Builds a single self-contained HTML page. React loads from cdnjs (or local node_modules with --local).
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const local = process.argv.includes('--local');
const web = process.argv.includes('--web');
const globals = {
  name: 'globals',
  setup(b) {
    b.onResolve({ filter: /^react(-dom)?(\/client)?$/ }, (a) => ({ path: a.path, namespace: 'g' }));
    b.onLoad({ filter: /.*/, namespace: 'g' }, (a) => ({
      contents: `module.exports = window.${a.path.startsWith('react-dom') ? 'ReactDOM' : 'React'};`,
      loader: 'js',
    }));
  },
};

const r = await build({
  entryPoints: ['src/main.tsx'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  write: false,
  jsx: 'transform',
  plugins: [globals],
  loader: { '.json': 'json' },
});
const js = r.outputFiles[0].text.replace(/<\/script/g, '<\\/script');
const css = readFileSync('src/styles.css', 'utf8');
const cdn = local
  ? ['node_modules/react/umd/react.production.min.js', 'node_modules/react-dom/umd/react-dom.production.min.js'].map((p) => `<script>${readFileSync(p, 'utf8')}</script>`).join('\n')
  : `<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js"></script>`;

const head = `<title>Solent Race Calculator</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans+Condensed:wght@400;500;600&display=swap">
<style>${css}</style>`;
const body = `<div id="root"></div>
${cdn}
<script>${js}</script>`;

mkdirSync('dist', { recursive: true });
if (web) {
  mkdirSync('dist/web', { recursive: true });
  writeFileSync('dist/web/index.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="description" content="Solent race calculator: tide-adjusted laylines, course to steer and vector triangles.">${head}<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font-size:14px}[hidden]{display:none!important}</style></head><body>${body}</body></html>`);
} else if (local) {
  writeFileSync('dist/local.html', `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">${head}</head><body>${body}</body></html>`);
} else {
  writeFileSync('dist/solent-race-calculator.html', `${head}\n${body}\n`);
}
console.log('built', local ? 'local' : 'artifact', (js.length / 1024).toFixed(0) + ' KB js');
