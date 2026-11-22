import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { sameRemote } from '../src/config.mjs';
import { addProject, fixture } from './helpers.mjs';

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('clone URLs for the same repository compare equal', () => {
  for (const [a, b] of [
    ['https://github.com/org/repo.git', 'git@github.com:org/repo'],
    ['https://github.com/Org/Repo', 'ssh://git@github.com:22/org/repo.git/'],
    ['git@github.com:org/repo.git', 'ssh://git@github.com/~/org/repo'],
    ['http://example.test/org/repo', 'git+ssh://example.test/org/repo.git'],
    ['/srv/repo/', '/srv/repo/.git'],
    ['/srv/repo', 'file:///srv/repo'],
  ])
    assert(sameRemote(a, b), `${a} should match ${b}`);
  for (const [a, b] of [
    ['https://github.com/org/repo', 'https://github.com/org/repo-fork'],
    ['https://github.com/org/repo', 'https://gitlab.com/org/repo'],
    ['git@github.com:org/repo', 'git@github.com:other/repo'],
    ['/srv/Repo', '/srv/repo'],
  ])
    assert(!sameRemote(a, b), `${a} should not match ${b}`);
});

test('a fork setup or another URL form still counts as the configured checkout', (t) => {
  const { home, git, source, config, command, ultrahome } = fixture(t);
  addProject(
    home,
    'https://example.test/org/payments.git',
    'payments',
    source('payments'),
  );
  // gh repo fork renames the project's remote to upstream and adds the fork
  // as origin.
  const checkout = path.join(home, 'payments');
  git(checkout, 'remote', 'rename', 'origin', 'upstream');
  git(checkout, 'remote', 'add', 'origin', 'git@example.test:me/payments.git');
  command('validate');
  command('setup');

  // The config switches to SSH. It's the same repository, so the checkout is
  // still the one Ultrahome cloned.
  const state = () =>
    JSON.parse(
      fs.readFileSync(path.join(home, '.ultrahome/state.json'), 'utf8'),
    ).repos.payments;
  assert.deepEqual(state(), {
    remote: 'https://example.test/org/payments.git',
  });
  const ssh = 'git@example.test:Org/payments';
  config({ projects: { payments: { remote: ssh } } });
  command('setup');
  assert.deepEqual(state(), { remote: ssh });
  command('validate');

  // add reuses the project when given another form of its URL.
  ultrahome(['add', 'https://example.test/org/payments', 'team/payments']);
  assert.equal(
    fs.readlinkSync(path.join(home, 'team/payments')),
    '../payments',
  );
});

test('a checkout of another repository blocks only its own path', (t) => {
  const { home, git, source, config, command } = fixture(t);
  const payments = source('payments');
  const moved = source('moved');
  config({
    projects: { payments: { remote: payments } },
    groups: { checkout: { projects: ['payments'] } },
  });
  command('setup');
  // The project moves, and a teammate's checkout still has the old URL.
  config({
    projects: {
      payments: { remote: moved },
      shipping: { remote: source('shipping') },
    },
    groups: {
      checkout: { projects: ['payments'] },
      fulfillment: { projects: ['shipping'] },
    },
  });
  const conflict = new RegExp(
    escape(
      `payments is a Git checkout, but none of its remotes points to ${moved}. If the project moved, run git -C payments remote set-url origin ${moved}. Otherwise`,
    ),
  );
  assert.match(command('setup', { failure: true }), conflict);
  // The rest of the home is set up.
  assert.equal(
    fs.readlinkSync(path.join(home, 'fulfillment/shipping')),
    '../shipping',
  );
  const validation = command('validate', { failure: true });
  assert.match(validation, conflict);
  assert.doesNotMatch(validation, /stale link checkout\/payments/);
  command('validate', { dir: path.join(home, 'fulfillment') });

  git(path.join(home, 'payments'), 'remote', 'set-url', 'origin', moved);
  command('setup');
  command('validate');
});

test('add refuses a path that something else holds and keeps the config', (t) => {
  const { home, source, read, ultrahome, command } = fixture(t);
  fs.mkdirSync(path.join(home, 'notes'));
  fs.writeFileSync(path.join(home, 'notes/todo.md'), 'mine\n');
  const before = read();
  assert.match(
    ultrahome(['add', source('notes-repo'), 'notes'], { failure: true }),
    /notes is occupied by something other than a Git checkout of .*notes-repo/,
  );
  assert.equal(read(), before);
  assert.equal(
    fs.readFileSync(path.join(home, 'notes/todo.md'), 'utf8'),
    'mine\n',
  );
  command('validate');
});

test('renaming a project only in letter case keeps its checkout', (t) => {
  const { home, source, config, command } = fixture(t);
  const remote = source('remote');
  config({ projects: { payments: { remote } } });
  command('setup');
  // On a case-insensitive filesystem the old path is the new one, so setup
  // must not tell the user to delete it as obsolete.
  config({ projects: { Payments: { remote } } });
  const outputs = [command('setup'), command('validate')];
  assert.equal(
    fs.readFileSync(path.join(home, 'Payments/README.md'), 'utf8'),
    '# remote\n',
  );
  if (fs.existsSync(path.join(home, 'PAYMENTS')))
    for (const output of outputs) assert.doesNotMatch(output, /rm -rf/);
});

test('the conflict names an existing remote and quotes its command', (t) => {
  const { home, base, git, source, config, command } = fixture(t);
  const remote = source("team's api");
  // A clone Ultrahome never recorded, with its only remote named fork.
  git(
    base,
    'clone',
    '-q',
    '-o',
    'fork',
    source('other'),
    path.join(home, 'api'),
  );
  config({ projects: { api: { remote } } });
  const quoted = `'${remote.replaceAll("'", "'\\''")}'`;
  assert.match(
    command('validate', { failure: true }),
    new RegExp(escape(`run git -C api remote set-url fork ${quoted}.`)),
  );
});
