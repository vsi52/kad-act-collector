import { execFile } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));
const release = resolve(root, 'release');
const version = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version;
const output = resolve(release, `KAD_Act_Collector_v${version}.zip`);
const sourceOutput = resolve(release, `KAD_Act_Collector_source_v${version}.zip`);

await mkdir(release, { recursive: true });
await rm(output, { force: true });
await rm(sourceOutput, { force: true });
await exec('zip', ['-q', '-r', output, '.'], { cwd: resolve(root, 'dist') });
await exec('zip', [
  '-q', '-r', sourceOutput,
  'src', 'public', 'docs', 'licenses', '.github',
  'package.json', 'package-lock.json', 'build.mjs', 'package.mjs', 'tests.mjs',
  'README.md', 'CHANGELOG.md', 'SECURITY.md', 'PUBLISHING.md',
  '.gitignore', '.gitattributes', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
  'SHA256SUMS.txt'
], { cwd: root });
console.log(output);
console.log(sourceOutput);
