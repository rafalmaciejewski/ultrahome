import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const cli = path.join(root, 'src/cli.mjs');

// Runs a command and returns its combined output, asserting that it
// succeeds, or fails when `failure` is set.
export function run(cwd, command, args, failure = false, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  if (result.error) throw result.error;
  const output = result.stdout + result.stderr;
  if (failure) assert.notEqual(result.status, 0, output);
  else assert.equal(result.status, 0, output);
  return output.trim();
}

// A temporary directory with an initialized home at `home`, removed after
// the test.
export function fixture(t) {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(tmpdir(), 'ultrahome-test-')),
  );
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  run(base, process.execPath, [cli, 'init', home]);
  const git = (cwd, ...args) => run(cwd, 'git', args);
  const commit = (cwd) => {
    git(cwd, 'add', '.');
    git(
      cwd,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.org',
      'commit',
      '-qm',
      'test',
    );
  };
  // A Git repo at `base/name` with a README and any extra files.
  const source = (name, files = {}) => {
    const repo = path.join(base, name);
    fs.mkdirSync(repo);
    git(repo, 'init', '-q');
    fs.writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`);
    for (const [file, text] of Object.entries(files))
      fs.writeFileSync(path.join(repo, file), text);
    commit(repo);
    return repo;
  };
  const config = (values) =>
    fs.writeFileSync(
      path.join(home, '.ultrahome.json'),
      JSON.stringify({ version: 1, ...values }),
    );
  const read = (scope = '', name = '.ultrahome.json') =>
    fs.readFileSync(path.join(home, scope, name), 'utf8');
  // Runs the CLI with any arguments.
  const ultrahome = (args, { failure = false, dir = home, env } = {}) =>
    run(dir, process.execPath, [cli, ...args], failure, env);
  const command = (action, options) => ultrahome([action], options);
  return {
    home,
    base,
    git,
    commit,
    source,
    config,
    read,
    ultrahome,
    command,
  };
}

// Adds a project from `url`, cloning `localRepo` instead through Git's URL
// rewriting, so the real clone path runs offline.
export function addProject(dir, url, id, localRepo, failure = false) {
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.${localRepo}.insteadOf`,
    GIT_CONFIG_VALUE_0: url,
  };
  return run(dir, process.execPath, [cli, 'add', url, id], failure, env);
}

export const exists = (file) =>
  fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
