import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './helpers.mjs';

test('init creates only the empty scaffold and preserves a configured home on rerun', (t) => {
  const { home, git, config, command } = fixture(t);
  assert.deepEqual(fs.readdirSync(home).sort(), [
    '.claude',
    '.git',
    '.gitignore',
    '.ignore',
    '.ultrahome',
    '.ultrahome.json',
    'AGENTS.md',
    'CLAUDE.md',
  ]);
  assert.equal(fs.readlinkSync(path.join(home, 'CLAUDE.md')), 'AGENTS.md');
  assert.deepEqual(fs.readdirSync(path.join(home, '.ultrahome')), []);
  assert.equal(
    git(home, 'check-ignore', '.ultrahome/anything'),
    '.ultrahome/anything',
  );
  const file = path.join(home, '.ultrahome.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), {
    version: 1,
    projects: {},
    groups: {},
  });
  config({
    projects: { a: { remote: '../unavailable' } },
    groups: { team: {} },
  });
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(path.join(home, 'AGENTS.md'), 'User guidance');
  command('init');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(
    fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8'),
    'User guidance',
  );
  assert(!fs.existsSync(path.join(home, 'a')));
  assert(!fs.existsSync(path.join(home, 'team')));
});

test('init finishes a home that only has a config', (t) => {
  const { base, command } = fixture(t);
  const dir = path.join(base, 'partial');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '.ultrahome.json'), '{"version":1}');
  command('init', { dir });
  assert(fs.statSync(path.join(dir, 'AGENTS.md')).isFile());
  command('validate', { dir });
});
