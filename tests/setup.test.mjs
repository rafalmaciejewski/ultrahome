import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { cli, fixture, run } from './helpers.mjs';

test('nested groups bootstrap from a fresh clone', (t) => {
  const { home, base, git, commit, source, config, command } = fixture(t);
  const a = source('source-a');
  const b = source('source-b');
  const c = source('source-c');
  config({
    projects: { a: { remote: a }, b: { remote: b }, c: { remote: c } },
    groups: {
      commerce: {
        groups: {
          checkout: { projects: ['a', 'b'] },
          fulfillment: { projects: ['c', 'b'] },
        },
      },
    },
  });
  command('setup');
  command('setup');
  command('validate');
  assert.equal(
    fs.realpathSync(path.join(home, 'commerce/checkout/b')),
    path.join(home, 'b'),
  );
  assert.equal(
    fs.realpathSync(path.join(home, 'commerce/fulfillment/b')),
    path.join(home, 'b'),
  );
  assert.equal(
    fs.realpathSync(path.join(home, 'commerce/fulfillment/c')),
    path.join(home, 'c'),
  );
  commit(home);
  const tracked = new Set(git(home, 'ls-files').split('\n'));
  for (const ignored of [
    'a',
    'b',
    'commerce/checkout/a',
    'commerce/fulfillment/b',
  ]) {
    assert(!tracked.has(ignored));
  }
  const joined = path.join(base, 'joined');
  git(base, 'clone', home, joined);
  command('setup', { dir: joined });
  command('validate', { dir: joined });
  assert.equal(git(joined, 'status', '--short'), '');
});

test('setup runs only from the home root, and validate checks one group from its directory', (t) => {
  const { home, source, config, command } = fixture(t);
  config({
    projects: {
      a: { remote: source('source-a') },
      b: { remote: source('source-b') },
      c: { remote: source('source-c') },
    },
    groups: {
      team: { projects: ['a', 'c'] },
      other: { projects: ['b'] },
    },
  });
  const team = path.join(home, 'team');
  fs.mkdirSync(team);
  fs.mkdirSync(path.join(home, 'notes'));
  for (const dir of [team, path.join(home, 'notes')]) {
    assert.match(
      command('setup', { dir, failure: true }),
      /Run npx ultrahome setup from the home root/,
    );
  }
  // A refused setup changes nothing.
  for (const id of ['a', 'b', 'c', 'team/a'])
    assert(!fs.existsSync(path.join(home, id)));

  command('setup');
  // From a checkout, or through a group's link to one, it's refused too.
  for (const dir of [path.join(home, 'a'), path.join(team, 'a')]) {
    assert.match(
      command('setup', { dir, failure: true }),
      /Run npx ultrahome setup from the home root/,
    );
  }

  fs.rmSync(path.join(home, 'b'), { recursive: true });
  command('validate', { dir: team });
  assert.match(command('validate', { failure: true }), /Missing checkout b/);
  assert.match(
    command('validate', { dir: path.join(home, 'notes'), failure: true }),
    /notes is not a group/,
  );
});

test('setup connects available projects and recovers after a failed clone', (t) => {
  const { home, base, source, config, command } = fixture(t);
  const a = source('source-a');
  const b = path.join(base, 'source-b');
  config({
    projects: { a: { remote: a }, b: { remote: b } },
    groups: { checkout: { projects: ['a', 'b'] } },
  });
  command('setup', { failure: true });
  assert(fs.lstatSync(path.join(home, 'checkout/a')).isSymbolicLink());
  assert(!fs.existsSync(path.join(home, 'checkout/b')));
  const state = JSON.parse(
    fs.readFileSync(path.join(home, '.ultrahome/state.json'), 'utf8'),
  );
  assert.deepEqual(Object.keys(state.repos), ['a']);
  source('source-b');
  assert.match(command('setup'), /Cloning b\.\.\.\nCloned b/);
  command('validate');
  assert(fs.lstatSync(path.join(home, 'checkout/b')).isSymbolicLink());
});

test('setup runs the same effective ignore checks as read-only validation', (t) => {
  const { home, config, source, command } = fixture(t);
  config({
    projects: { api: { remote: source('remote') } },
    groups: { team: { projects: ['api'] } },
  });
  command('setup');
  const rootIgnore = path.join(home, '.gitignore');
  const original = fs.readFileSync(rootIgnore, 'utf8');
  fs.appendFileSync(rootIgnore, '!/api\n');
  const groupIgnore = path.join(home, 'team/.gitignore');
  fs.writeFileSync(groupIgnore, '!/api\n');
  for (const action of ['setup', 'validate']) {
    const message = command(action, { failure: true });
    assert.match(message, /Git does not ignore api\./);
    assert.match(message, /Git does not ignore team\/api\./);
    assert.doesNotMatch(message, /complete/);
  }
  fs.unlinkSync(groupIgnore);
  fs.writeFileSync(rootIgnore, original.replace('/api\n', ''));
  assert.match(
    command('validate', { failure: true }),
    /Managed ignore rules are stale/,
  );
  assert.match(command('setup'), /Ultrahome setup complete/);
  assert.equal(fs.readFileSync(rootIgnore, 'utf8'), original);
});

test('validate reports a missing empty group', (t) => {
  const { config, command } = fixture(t);
  config({ groups: { team: {} } });
  assert.match(command('validate', { failure: true }), /Missing group team/);
  command('setup');
  command('validate');
});

test("a group's path can't hold a Git checkout or a file", (t) => {
  const { config, command, home, source } = fixture(t);
  fs.renameSync(source('other'), path.join(home, 'team'));
  config({ groups: { team: { groups: { child: {} } } } });
  assert.match(command('setup', { failure: true }), /team is a Git checkout/);
  assert(!fs.existsSync(path.join(home, 'team/child')));
  fs.writeFileSync(path.join(home, 'notes'), 'not a group\n');
  config({ groups: { notes: {} } });
  assert.match(
    command('setup', { failure: true }),
    /notes must be a directory/,
  );
});

test('groups must stay inside the home on first setup', (t) => {
  const { config, command, base, home, source } = fixture(t);
  const elsewhere = fs.mkdtempSync(path.join(base, 'outside-'));
  fs.symlinkSync(elsewhere, path.join(home, 'team'));
  config({
    projects: { a: { remote: source('remote') } },
    groups: { team: { projects: ['a'] } },
  });
  assert.match(command('setup', { failure: true }), /symlink/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('a relative local remote works on setup and subsequent validation', (t) => {
  const { config, command, source } = fixture(t);
  source('local-source');
  config({
    projects: { a: { remote: '../local-source' } },
    groups: { team: { projects: ['a'] } },
  });
  command('setup');
  command('validate');
  command('setup');
});

test('commands refuse local state that the home tracks', (t) => {
  const { home, git, command } = fixture(t);
  fs.writeFileSync(
    path.join(home, '.ultrahome/state.json'),
    JSON.stringify({ repos: {}, links: {} }),
  );
  git(home, 'add', '-f', '.ultrahome/state.json');
  for (const action of ['setup', 'validate'])
    assert.match(command(action, { failure: true }), /Git tracks \.ultrahome/);
  git(home, 'rm', '-q', '-r', '--cached', '.ultrahome');
  command('setup');
});

test('setup ignores repository variables inherited from a Git hook', (t) => {
  const { home, git, source, config } = fixture(t);
  const other = source('other');
  const remote = source('source-a');
  config({ projects: { a: { remote } } });
  run(home, process.execPath, [cli, 'setup'], false, {
    ...process.env,
    GIT_DIR: path.join(other, '.git'),
    GIT_WORK_TREE: other,
  });
  // The clone has its own repository, and the hook's repository is untouched.
  assert(fs.statSync(path.join(home, 'a/.git')).isDirectory());
  assert.equal(
    git(path.join(home, 'a'), 'config', '--get', 'remote.origin.url'),
    remote,
  );
  assert.equal(git(other, 'remote'), '');
  assert.equal(git(other, 'status', '--porcelain'), '');
});

test('baseBranch picks the branch of the first clone', (t) => {
  const { home, git, commit, source, config, command } = fixture(t);
  const remote = source('remote');
  git(remote, 'switch', '-q', '-c', 'develop');
  fs.writeFileSync(path.join(remote, 'develop.txt'), 'develop\n');
  commit(remote);
  git(remote, 'switch', '-q', '-');
  config({
    projects: {
      feature: { remote, baseBranch: 'develop' },
      default: { remote },
    },
  });
  command('setup');
  const branch = (entry) =>
    git(path.join(home, entry), 'branch', '--show-current');
  assert.equal(branch('feature'), 'develop');
  assert(fs.existsSync(path.join(home, 'feature/develop.txt')));
  assert.equal(branch('default'), git(remote, 'branch', '--show-current'));
  assert(!fs.existsSync(path.join(home, 'default/develop.txt')));
  command('validate');
});

test('setup refuses local state that points outside its managed paths', (t) => {
  const { home, source, config, command } = fixture(t);
  config({ projects: { a: { remote: source('remote') } } });
  command('setup');
  const file = path.join(home, '.ultrahome/state.json');
  const original = fs.readFileSync(file, 'utf8');
  fs.renameSync(source('notes-repo'), path.join(home, 'notes'));
  for (const [state, message] of [
    [
      { repos: {}, links: { 'notes/a': '../a' } },
      /notes\/a is inside the Git checkout at notes/,
    ],
    [
      { repos: { '../outside': { remote: 'x' } }, links: {} },
      /Invalid managed path/,
    ],
    // Checkouts sit at the home root, and links in groups.
    [
      { repos: { 'notes/a': { remote: 'x' } }, links: {} },
      /Invalid managed path or value in local state: notes\/a/,
    ],
    [
      { repos: {}, links: { a: '../a' } },
      /Invalid managed path or value in local state: a/,
    ],
    [{ repos: {}, links: { a: { remote: 'x' } } }, /Invalid managed path/],
    [{ repos: { a: { remote: '' } }, links: {} }, /Invalid managed path/],
    [
      { repos: { a: { remote: 'x', path: '/' } }, links: {} },
      /checkout record: unexpected field "path"/,
    ],
    [
      { repos: {}, links: {}, extra: {} },
      /local state: unexpected field "extra"/,
    ],
  ]) {
    fs.writeFileSync(file, JSON.stringify(state));
    for (const action of ['setup', 'validate'])
      assert.match(command(action, { failure: true }), message);
  }
  fs.writeFileSync(file, original);
  command('validate');
  assert(fs.existsSync(path.join(home, 'a/README.md')));
});
