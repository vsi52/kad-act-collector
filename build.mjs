import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, 'dist');

await mkdir(dist, { recursive: true });

await build({
  entryPoints: [resolve(root, 'src/content.js')],
  outfile: resolve(dist, 'content.js'),
  bundle: true,
  format: 'iife',
  target: ['chrome120'],
  minify: true,
  legalComments: 'none'
});

// Manifest V3 forbids dynamically generated code. PDF.js only uses this snippet
// to test whether eval-like execution is available; text extraction does not need it.
const contentPath = resolve(dist, 'content.js');
const bundledContent = await readFile(contentPath, 'utf8');
const cspSafeContent = bundledContent.replace(
  /try\{return new Function\(""\),!0\}catch\{return!1\}/g,
  'return!1'
);
if (cspSafeContent.includes('new Function')) {
  throw new Error('Dynamic code remained in content bundle');
}
await writeFile(contentPath, cspSafeContent);

await build({
  entryPoints: [resolve(root, 'src/workspace.js')],
  outfile: resolve(dist, 'workspace.js'),
  bundle: true,
  format: 'iife',
  target: ['chrome120'],
  minify: true,
  legalComments: 'none'
});

const workspacePath = resolve(dist, 'workspace.js');
const bundledWorkspace = await readFile(workspacePath, 'utf8');
const cspSafeWorkspace = bundledWorkspace.replace(
  /try\{return new Function\(""\),!0\}catch\{return!1\}/g,
  'return!1'
);
if (cspSafeWorkspace.includes('new Function')) {
  throw new Error('Dynamic code remained in workspace bundle');
}
await writeFile(workspacePath, cspSafeWorkspace);

for (const file of ['manifest.json', 'background.js', 'content.css', 'workspace.html', 'workspace.css', 'terms.html', 'privacy.html', 'third-party.html']) {
  await cp(resolve(root, `src/${file}`), resolve(dist, file));
}

await cp(resolve(root, 'public/icons'), resolve(dist, 'icons'), { recursive: true });
await cp(resolve(root, 'LICENSE'), resolve(dist, 'LICENSE'));
await cp(resolve(root, 'THIRD_PARTY_NOTICES.md'), resolve(dist, 'THIRD_PARTY_NOTICES.md'));
await cp(
  resolve(root, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs'),
  resolve(dist, 'pdf.worker.min.mjs')
);
await cp(resolve(root, 'node_modules/pdfjs-dist/LICENSE'), resolve(dist, 'PDFJS_LICENSE.txt'));

const manifestPath = resolve(dist, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.version = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Built ${dist}`);
