import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture, run } from './helpers.mjs';

test('the fetch guard stops pulls that would delete or overwrite managed paths', (t) => {
  const { home, base, git, commit, source, config, command } = fixture(t);
  config({
    projects: {
      a: { remote: source('source-a') },
      b: { remote: source('source-b') },
    },
    groups: { team: { projects: ['a', 'b'] } },
  });
  command('setup');
  commit(home);
  const remote = path.join(base, 'home.git');
  git(base, 'clone', '-q', '--bare', home, remote);
  git(home, 'remote', 'add', 'origin', remote);
  git(home, 'fetch', '-q', 'origin');
  const branch = git(home, 'branch', '--show-current');
  git(home, 'branch', '-q', '--set-upstream-to', `origin/${branch}`);
  const teammate = path.join(base, 'teammate');
  git(base, 'clone', '-q', remote, teammate);
  const push = (...files) => {
    for (const file of files) {
      const target = path.join(teammate, file);
      // A group directory can hold tracked files, such as its AGENTS.md.
      if (fs.statSync(target, { throwIfNoEntry: false })?.isDirectory())
        git(teammate, 'rm', '-rq', file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'replaced\n');
      git(teammate, 'add', '-f', file);
    }
    commit(teammate);
    git(teammate, 'push', '-q', 'origin', branch);
  };
  const local = path.join(home, '.claude/settings.local.json');
  const settings = fs.readFileSync(local, 'utf8');
  // The guard names the first tracked path that collides.
  for (const [file, collision] of [
    ['A', 'a'], // A checkout path, in another case
    ['team/b/README.md', 'team/b'], // Beneath a link
    ['team', 'team'], // Replaces the group directory above checkouts
    ['team/a', 'team/a'], // A link path
    ['.ultrahome/state.json', '.ultrahome'], // Local state
    ['.claude/settings.local.json', '.claude/settings.local.json'], // Local Claude Code settings
  ]) {
    push(file);
    assert.match(
      run(home, 'git', ['pull', '--ff-only'], true),
      new RegExp(`refused to update .* tracks ${collision}, `),
    );
    assert.equal(
      fs.readFileSync(path.join(home, 'a/README.md'), 'utf8'),
      '# source-a\n',
    );
    assert.equal(
      fs.readFileSync(path.join(home, 'team/b/README.md'), 'utf8'),
      '# source-b\n',
    );
    assert(fs.lstatSync(path.join(home, 'team/a')).isSymbolicLink());
    assert.equal(fs.readFileSync(local, 'utf8'), settings);
    git(teammate, 'reset', '-q', '--hard', 'HEAD~1');
    git(teammate, 'push', '-q', '--force', 'origin', branch);
  }
  push('NOTES.md');
  git(home, 'pull', '-q', '--ff-only');
  assert(fs.existsSync(path.join(home, 'NOTES.md')));
  command('validate');
});

test('validate reports a stale fetch guard and warns when Git would skip it', (t) => {
  const { home, git, command } = fixture(t);
  command('validate');
  const hook = path.join(home, '.git/hooks/reference-transaction');
  fs.rmSync(hook);
  assert.match(
    command('validate', { failure: true }),
    /fetch guard is missing or stale/,
  );
  command('setup');
  assert(fs.statSync(hook).mode & 0o100);
  const own = '#!/bin/sh\nexit 0\n';
  fs.writeFileSync(hook, own);
  assert.match(command('setup'), /another hook is already installed/);
  assert.equal(fs.readFileSync(hook, 'utf8'), own);
  fs.rmSync(hook);
  git(home, 'config', 'core.hooksPath', 'custom-hooks');
  assert.match(command('validate'), /core\.hooksPath makes Git run hooks/);
  command('setup');
  assert(!fs.existsSync(hook));
});

test('a refused branch says how to keep pulling the current one', (t) => {
  const { home, base, git, commit, source, config, command } = fixture(t);
  config({ projects: { a: { remote: source('source-a') } } });
  command('setup');
  commit(home);
  const remote = path.join(base, 'home.git');
  git(base, 'clone', '-q', '--bare', home, remote);
  git(home, 'remote', 'add', 'origin', remote);
  git(home, 'fetch', '-q', 'origin');
  const branch = git(home, 'branch', '--show-current');
  git(home, 'branch', '-q', '--set-upstream-to', `origin/${branch}`);

  // A teammate pushes a branch that tracks the checkout's path, and a commit
  // that's fine on the current branch.
  const teammate = path.join(base, 'teammate');
  git(base, 'clone', '-q', remote, teammate);
  git(teammate, 'switch', '-q', '-c', 'restructure');
  fs.mkdirSync(path.join(teammate, 'a'));
  fs.writeFileSync(path.join(teammate, 'a/AGENTS.md'), '# A\n');
  git(teammate, 'add', '-f', 'a');
  commit(teammate);
  git(teammate, 'push', '-q', 'origin', 'restructure');
  git(teammate, 'switch', '-q', branch);
  fs.writeFileSync(path.join(teammate, 'NOTES.md'), 'notes\n');
  commit(teammate);
  git(teammate, 'push', '-q', 'origin', branch);

  // The whole fetch fails, so the message names the branch to fix and how
  // to pull the current one meanwhile.
  assert.match(
    run(home, 'git', ['pull', '--ff-only'], true),
    new RegExp(
      `refused to update refs/remotes/origin/restructure\\. Its commit tracks a, .* Your current branch isn't affected: update it with git pull origin ${branch}\\. To fetch refs/remotes/origin/restructure, remove a from that branch or delete it\\.`,
    ),
  );
  git(home, 'pull', '-q', '--ff-only', 'origin', branch);
  assert(fs.existsSync(path.join(home, 'NOTES.md')));
  assert.equal(
    fs.readFileSync(path.join(home, 'a/README.md'), 'utf8'),
    '# source-a\n',
  );
  command('validate');
});
