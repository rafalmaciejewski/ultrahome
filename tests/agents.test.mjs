import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { exists, fixture, run } from './helpers.mjs';

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const directories = (home, group) =>
  read(path.join(home, group, '.claude/settings.json')).permissions
    .additionalDirectories;

test('setup lets Claude Code sessions in a group edit the checkouts it links to', (t) => {
  const { home, source, config, command } = fixture(t);
  config({
    projects: {
      a: { remote: source('a') },
      b: { remote: source('b') },
      c: { remote: source('c') },
    },
    groups: {
      checkout: { projects: ['a', 'b'] },
      commerce: { groups: { returns: { projects: ['a', 'c'] } } },
      empty: {},
    },
  });
  command('setup');
  assert.deepEqual(read(path.join(home, 'checkout/.claude/settings.json')), {
    permissions: { additionalDirectories: ['../a', '../b'] },
  });
  // A session started in a parent group reaches its subgroups' links too.
  assert.deepEqual(directories(home, 'commerce'), ['../a', '../c']);
  assert.deepEqual(directories(home, 'commerce/returns'), [
    '../../a',
    '../../c',
  ]);
  // A group without links needs no settings.
  assert(!exists(path.join(home, 'empty/.claude')));
  command('validate');
});

test("group settings keep the user's own content and entries", (t) => {
  const { home, source, config, command } = fixture(t);
  const projects = { a: { remote: source('a') }, b: { remote: source('b') } };
  config({ projects, groups: { team: { projects: ['a'] } } });
  const file = path.join(home, 'team/.claude/settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const allow = ['Bash(npm test)'];
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        model: 'opus',
        permissions: { allow, additionalDirectories: ['~/notes', '../a/'] },
      },
      null,
      2,
    ),
  );
  command('setup');
  // An entry for the checkout counts even when spelled differently.
  assert.deepEqual(directories(home, 'team'), ['~/notes', '../a/']);

  config({ projects, groups: { team: { projects: ['b'] } } });
  assert.match(
    command('validate', { failure: true }),
    /team\/\.claude\/settings\.json doesn't give Claude Code access to b in permissions\.additionalDirectories, so sessions in team can't edit them/,
  );
  command('setup');
  assert.deepEqual(read(file), {
    model: 'opus',
    permissions: { allow, additionalDirectories: ['~/notes', '../b'] },
  });

  // With no links left, only Ultrahome's entries go.
  config({ projects, groups: { team: {} } });
  command('setup');
  assert.deepEqual(read(file), {
    model: 'opus',
    permissions: { allow, additionalDirectories: ['~/notes'] },
  });
  command('validate');
});

test('add and remove update group settings, and remove deletes its own file', (t) => {
  const { home, source, config, command, ultrahome } = fixture(t);
  const a = source('a');
  config({ projects: { a: { remote: a } }, groups: { team: {} } });
  command('setup');
  ultrahome(['add', a, 'team/a']);
  assert.deepEqual(directories(home, 'team'), ['../a']);
  command('validate');
  assert.match(
    ultrahome(['remove', 'team/a']),
    /Removed team\/\.claude\/settings\.json, since team links no projects/,
  );
  assert(!exists(path.join(home, 'team/.claude')));
  command('validate');
  // Other Claude Code files in the group stay.
  ultrahome(['add', a, 'team/a']);
  const review = path.join(home, 'team/.claude/commands/review.md');
  fs.mkdirSync(path.dirname(review));
  fs.writeFileSync(review, 'Review the diff.\n');
  ultrahome(['remove', 'team/a']);
  assert(!exists(path.join(home, 'team/.claude/settings.json')));
  assert(exists(review));
});

test('setup reports group settings it cannot read', (t) => {
  const { home, source, config, command } = fixture(t);
  config({
    projects: { a: { remote: source('a') } },
    groups: { team: { projects: ['a'] } },
  });
  const file = path.join(home, 'team/.claude/settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const [text, message] of [
    ['{"permissions": []}', /permissions must be an object/],
    ['{"permissions": {"additionalDirectories": "../a"}}', /must be a list/],
    ['{"permissions": ', /team\/\.claude\/settings\.json: /],
  ]) {
    fs.writeFileSync(file, text);
    assert.match(command('setup', { failure: true }), message);
  }
});

test('setup clears the settings and directories of groups the layout drops', (t) => {
  const { home, source, config, command } = fixture(t);
  const projects = { a: { remote: source('a') } };
  config({
    projects,
    groups: {
      team: { projects: ['a'] },
      commerce: { groups: { returns: { projects: ['a'] } } },
    },
  });
  command('setup');
  fs.writeFileSync(path.join(home, 'team/AGENTS.md'), '# Team\n');
  command('setup');
  assert.deepEqual(directories(home, 'team'), ['../a']);
  assert.deepEqual(directories(home, 'commerce/returns'), ['../../a']);

  config({ projects });
  command('setup');
  // A group with files of its own keeps its directory, but not the settings
  // that still let sessions there edit its old projects.
  assert(!exists(path.join(home, 'team/.claude')));
  assert(exists(path.join(home, 'team/AGENTS.md')));
  assert(!exists(path.join(home, 'commerce')));
  command('validate');
});

test('the home decides whether to commit group settings', (t) => {
  const { home, git, commit, source, config, ultrahome, command } = fixture(t);
  const b = source('b');
  config({
    projects: { a: { remote: source('a') }, b: { remote: b } },
    groups: { team: { projects: ['a'] } },
  });
  command('setup');
  const file = 'team/.claude/settings.json';
  // Ultrahome doesn't ignore them.
  run(home, 'git', ['check-ignore', file], true);
  // Committed, they're the same for every teammate, and setup keeps them up
  // to date.
  commit(home);
  assert.equal(git(home, 'ls-files', 'team'), file);
  command('setup');
  assert.equal(git(home, 'status', '--short'), '');
  ultrahome(['add', b, 'team/b']);
  assert.equal(git(home, 'diff', '--name-only', '--', file), file);
  assert.deepEqual(directories(home, 'team'), ['../a', '../b']);
  command('validate');
  // The home can ignore them instead.
  git(home, 'rm', '-q', '--cached', file);
  fs.appendFileSync(path.join(home, '.gitignore'), `/${file}\n`);
  command('setup');
  assert.equal(git(home, 'check-ignore', file), file);
});

test("the home's local settings base Claude Code worktrees on the local HEAD", (t) => {
  const { home, git, commit, command } = fixture(t);
  const name = '.claude/settings.local.json';
  const file = path.join(home, name);
  // init writes them, and Git ignores them.
  assert.deepEqual(read(file), { worktree: { baseRef: 'head' } });
  assert.equal(git(home, 'check-ignore', name), name);
  // setup adds the base when it's missing and keeps the user's settings.
  const allow = ['Bash(npm test)'];
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow } }, null, 2));
  assert.match(
    command('validate', { failure: true }),
    /settings\.local\.json doesn't set worktree\.baseRef/,
  );
  command('setup');
  assert.deepEqual(read(file), {
    permissions: { allow },
    worktree: { baseRef: 'head' },
  });
  fs.rmSync(path.join(home, '.claude'), { recursive: true });
  command('setup');
  assert.deepEqual(read(file), { worktree: { baseRef: 'head' } });
  // A base the user chose stays, with a warning.
  fs.writeFileSync(file, JSON.stringify({ worktree: { baseRef: 'fresh' } }));
  assert.match(command('setup'), /sets worktree\.baseRef to "fresh"/);
  assert.deepEqual(read(file), { worktree: { baseRef: 'fresh' } });
  fs.writeFileSync(file, JSON.stringify({ worktree: 'head' }));
  assert.match(
    command('setup', { failure: true }),
    /worktree must be an object/,
  );
  // Tracked settings stop commands.
  fs.writeFileSync(file, JSON.stringify({ worktree: { baseRef: 'head' } }));
  commit(home);
  git(home, 'add', '-f', name);
  assert.match(
    command('validate', { failure: true }),
    /Git tracks \.claude\/settings\.local\.json/,
  );
});

test('validate accepts any entry that covers the checkouts, and reports gaps', (t) => {
  const { home, source, config, command } = fixture(t);
  config({
    projects: { a: { remote: source('a') }, b: { remote: source('b') } },
    groups: { commerce: { groups: { team: { projects: ['a', 'b'] } } } },
  });
  // An entry for the whole home covers every checkout, so setup adds none.
  const file = path.join(home, 'commerce/team/.claude/settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const whole = { permissions: { additionalDirectories: ['../..'] } };
  fs.writeFileSync(file, JSON.stringify(whole));
  command('setup');
  assert.deepEqual(read(file), whole);
  command('validate');

  fs.writeFileSync(
    file,
    JSON.stringify({ permissions: { additionalDirectories: ['../../b'] } }),
  );
  assert.match(
    command('validate', { failure: true }),
    /commerce\/team\/\.claude\/settings\.json doesn't give Claude Code access to a in permissions\.additionalDirectories/,
  );
  command('setup');
  assert.deepEqual(directories(home, 'commerce/team'), ['../../b', '../../a']);
  command('validate');
});
