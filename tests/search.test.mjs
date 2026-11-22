import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture, run } from './helpers.mjs';

const managed = (lines) =>
  [
    '# BEGIN ULTRAHOME MANAGED PATHS',
    '# Lets search tools such as ripgrep see the projects that .gitignore hides.',
    ...lines,
    '# END ULTRAHOME MANAGED PATHS',
  ].join('\n');

// Two root projects and a group that links both.
function workspace(t) {
  const context = fixture(t);
  const { config, source } = context;
  config({
    projects: {
      a: { remote: source('source-a', { 'code.txt': 'needle\n' }) },
      b: { remote: source('source-b', { 'code.txt': 'needle\n' }) },
    },
    groups: { team: { projects: ['a', 'b'] } },
  });
  return context;
}

test('setup lists checkouts and links as exceptions in .ignore', (t) => {
  const { home, git, command } = workspace(t);
  const file = path.join(home, '.ignore');
  fs.writeFileSync(file, '*.log\n');
  command('setup');
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    `*.log\n${managed(['!/a', '!/b', '!/team/a', '!/team/b'])}\n`,
  );
  // Git doesn't read .ignore, so the checkouts stay out of the home.
  assert.equal(git(home, 'check-ignore', 'a', 'team/a'), 'a\nteam/a');
  command('validate');

  fs.writeFileSync(file, `*.log\n${managed(['!/a'])}\n`);
  assert.match(
    command('validate', { failure: true }),
    /search rules in \.ignore are stale/,
  );
  command('setup');
  command('validate');

  fs.writeFileSync(file, '# BEGIN ULTRAHOME MANAGED PATHS\n');
  assert.match(
    command('setup', { failure: true }),
    /Fix the Ultrahome markers in \.ignore/,
  );
});

// ripgrep reads .ignore. Claude Code's Grep tool and most agent search tools
// are built on it.
const ripgrep = spawnSync('rg', ['--version']).error === undefined;

test('ripgrep finds project files from the home root and in groups', (t) => {
  if (!ripgrep) {
    // CI installs ripgrep, so the check can't silently go missing there.
    assert(!process.env.CI, 'Install ripgrep to run this test');
    t.skip('ripgrep is not installed');
    return;
  }
  const { home, command } = workspace(t);
  command('setup');
  // A checkout's own ignore rules still apply.
  fs.mkdirSync(path.join(home, 'a/node_modules'));
  fs.writeFileSync(path.join(home, 'a/node_modules/dep.txt'), 'needle\n');
  fs.writeFileSync(path.join(home, 'a/.gitignore'), 'node_modules/\n');
  const search = (dir, ...args) =>
    run(path.join(home, dir), 'rg', ['-l', ...args, 'needle', '.'], false)
      .split('\n')
      .map((file) => path.normalize(file))
      .sort();

  // From the root, each checkout appears once: links aren't followed.
  assert.deepEqual(search('.'), [
    path.join('a', 'code.txt'),
    path.join('b', 'code.txt'),
  ]);
  // A group's links need --follow, or the project's path.
  run(path.join(home, 'team'), 'rg', ['-l', 'needle', '.'], true);
  assert.equal(
    run(path.join(home, 'team'), 'rg', ['-l', 'needle', 'a']),
    path.join('a', 'code.txt'),
  );
  assert.deepEqual(search('team', '--follow'), [
    path.join('a', 'code.txt'),
    path.join('b', 'code.txt'),
  ]);

  // Without the exceptions, .gitignore hides every project.
  fs.rmSync(path.join(home, '.ignore'));
  run(home, 'rg', ['-l', 'needle', '.'], true);
});
