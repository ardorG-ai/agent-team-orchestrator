import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['bin', 'src', 'test', 'scripts'];
const files = [];

function walk(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) walk(child);
    else if (extname(entry.name) === '.mjs') files.push(child);
  }
}

for (const root of roots) {
  try {
    if (statSync(root).isDirectory()) walk(root);
  } catch {}
}

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', shell: false });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `syntax check failed: ${file}\n`);
    process.exitCode = 1;
  }
  const source = readFileSync(file, 'utf8');
  if (/\b(?:exec|spawn)\s*\([^\n]*shell\s*:\s*true/.test(source)) {
    process.stderr.write(`unsafe shell:true usage: ${file}\n`);
    process.exitCode = 1;
  }
}

if (!process.exitCode) process.stdout.write(`checked ${files.length} JavaScript files\n`);
