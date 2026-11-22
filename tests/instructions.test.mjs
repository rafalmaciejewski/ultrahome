import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { exists, fixture } from './helpers.mjs';

test('setup links a CLAUDE.md to each AGENTS.md so Claude Code reads it', (t) => {
  const { home, base, git, commit, config, command } = fixture(t);
  config({
    groups: {
      team: {},
      imported: {},
      custom: {},
      broken: {},
      plain: {},
      nested: {},
      misdirected: {},
    },
  });
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
    fs.writeFileSync(path.join(home, file), text);
  };
  write('team/AGENTS.md', '# Team\n');
  write('imported/AGENTS.md', '# Imported\n');
  write('imported/CLAUDE.md', '@AGENTS.md\n\nClaude-only notes.\n');
  write('custom/AGENTS.md', '# Custom\n');
  write('custom/CLAUDE.md', 'Instructions without the import.\n');
  write('broken/AGENTS.md', '# Broken\n');
  fs.symlinkSync('missing.md', path.join(home, 'broken/CLAUDE.md'));
  fs.mkdirSync(path.join(home, 'plain'));
  // Claude Code resolves imports from the file that holds them.
  write('nested/AGENTS.md', '# Nested\n');
  write('nested/.claude/CLAUDE.md', '@../AGENTS.md\n');
  write('misdirected/AGENTS.md', '# Misdirected\n');
  write('misdirected/.claude/CLAUDE.md', '@AGENTS.md\n');

  const output = command('setup');
  assert.match(
    output,
    /Added team\/CLAUDE\.md so Claude Code reads AGENTS\.md/,
  );
  assert.equal(fs.readlinkSync(path.join(home, 'team/CLAUDE.md')), 'AGENTS.md');
  assert.equal(
    fs.readFileSync(path.join(home, 'imported/CLAUDE.md'), 'utf8'),
    '@AGENTS.md\n\nClaude-only notes.\n',
  );
  // A CLAUDE.md of the user's own is never replaced, only reported.
  assert.match(
    output,
    /custom\/CLAUDE\.md doesn't link to or import AGENTS\.md, so Claude Code skips custom\/AGENTS\.md/,
  );
  assert.equal(
    fs.readFileSync(path.join(home, 'custom/CLAUDE.md'), 'utf8'),
    'Instructions without the import.\n',
  );
  assert.match(output, /broken\/CLAUDE\.md doesn't link to or import/);
  assert.equal(
    fs.readlinkSync(path.join(home, 'broken/CLAUDE.md')),
    'missing.md',
  );
  assert(!exists(path.join(home, 'plain/CLAUDE.md')));
  assert(!exists(path.join(home, 'nested/CLAUDE.md')));
  assert.doesNotMatch(output, /nested/);
  assert.match(
    output,
    /misdirected\/\.claude\/CLAUDE\.md doesn't link to or import AGENTS\.md, .* Add a line with @\.\.\/AGENTS\.md to it\./,
  );
  assert.doesNotMatch(command('validate'), /imported|team/);

  fs.rmSync(path.join(home, 'team/CLAUDE.md'));
  assert.match(
    command('validate', { failure: true }),
    /Missing team\/CLAUDE\.md, so some Claude Code sessions skip team\/AGENTS\.md/,
  );
  command('setup');

  // Git keeps the links, so teammates get them on clone.
  commit(home);
  assert.match(git(home, 'ls-files', '-s', 'CLAUDE.md'), /^120000 /);
  const joined = path.join(base, 'joined');
  git(base, 'clone', '-q', home, joined);
  assert.equal(
    fs.readlinkSync(path.join(joined, 'team/CLAUDE.md')),
    'AGENTS.md',
  );
  command('setup', { dir: joined });
  assert.equal(git(joined, 'status', '--short'), '');
});
