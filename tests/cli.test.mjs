import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cli, root, run } from './helpers.mjs';

test('CLI help works outside a home for the root and each command', () => {
  const invoke = (...args) => run(tmpdir(), process.execPath, [cli, ...args]);
  const overview = invoke('help');
  assert.match(overview, /help \[command\]/);
  for (const args of [[], ['--help'], ['-h']])
    assert.equal(invoke(...args), overview);
  for (const command of ['init', 'add', 'remove', 'setup', 'validate']) {
    const help = invoke('help', command);
    assert.match(help, new RegExp(`Usage: ultrahome ${command}\\b`));
    assert.equal(invoke(command, '--help'), help);
    assert.equal(invoke(command, '-h'), help);
  }
  assert.match(invoke('help', 'add'), /<source> <path>/);
  assert.equal(invoke('rm', '--help'), invoke('help', 'remove'));
  for (const command of ['setup', 'validate', 'remove a'])
    assert.match(
      run(tmpdir(), process.execPath, [cli, ...command.split(' ')], true),
      /No home found/,
    );
  const metadata = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  );
  assert.equal(invoke('--version'), metadata.version);
  assert.equal(invoke('-v'), metadata.version);
});
