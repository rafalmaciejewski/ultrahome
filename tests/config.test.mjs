import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Layout } from '../src/config.mjs';
import { TRANSPORTS } from '../src/git.mjs';
import { fixture, run } from './helpers.mjs';

// Loads `values` as a home's config, the way every command does, and returns
// the error, or '' for a valid layout.
function layoutError(values) {
  try {
    new Layout('/home', JSON.stringify({ version: 1, ...values }));
    return '';
  } catch (error) {
    return error.message;
  }
}

test('setup rejects duplicate JSON keys before cloning', (t) => {
  const { home, source, config, command } = fixture(t);
  config({ projects: { a: { remote: source('remote') } } });
  fs.writeFileSync(
    path.join(home, '.ultrahome.json'),
    '{"version":1,"version":1}',
  );
  assert.match(command('setup', { failure: true }), /Duplicate JSON key/);
  assert(!fs.existsSync(path.join(home, 'a')));
});

test('configs only register projects at the root and link them in groups', () => {
  const check = (values, failure) => {
    const error = layoutError(values);
    assert.equal(Boolean(error), failure, error);
    return error;
  };
  const api = { remote: 'git@example.test:org/api.git' };

  check({ projects: { api }, groups: { team: { projects: ['api'] } } }, false);
  assert.match(
    check({ projects: { api: api.remote } }, true),
    /project api must be an object/,
  );
  assert.match(
    check({ projects: { api: { ...api, branch: 'main' } } }, true),
    /project api: unexpected field "branch"/,
  );
  // A group lists the IDs of projects that the config's projects register.
  assert.match(
    check({ projects: { api }, groups: { team: { projects: 'api' } } }, true),
    /group team projects must be a list of unique project IDs/,
  );
  assert.match(
    check({ projects: { api }, groups: { team: { project: ['api'] } } }, true),
    /group team: unexpected field "project"/,
  );
  assert.match(
    check({ groups: { team: { projects: ['web'] } } }, true),
    /unknown project "web"/,
  );
  assert.match(check({ group: {} }, true), /unexpected field "group"/);
  assert.match(
    check({ projects: { api }, groups: { api: {} } }, true),
    /both a group and a project/,
  );
});

test('the config is plain JSON, without comments or trailing commas', (t) => {
  const { home, source, command } = fixture(t);
  const remote = JSON.stringify(source('remote'));
  for (const layout of [
    `{
  // Shared projects
  "version": 1,
  "projects": { "a": { "remote": ${remote} } }
}
`,
    `{
  "version": 1,
  "projects": { "a": { "remote": ${remote}, }, },
}
`,
  ]) {
    fs.writeFileSync(path.join(home, '.ultrahome.json'), layout);
    assert.match(command('setup', { failure: true }), /\.ultrahome\.json: /);
    assert(!fs.existsSync(path.join(home, 'a')));
  }
});

test('config remotes are limited to HTTP(S), SSH, and local paths', (t) => {
  const { base, source } = fixture(t);
  const check = (remote) => layoutError({ projects: { p: { remote } } });
  for (const remote of [
    'helper::payload',
    'fd::3',
    'ext::sh -c touch% pwned',
    'git://example.test/org/api.git',
    'FTP://example.test/org/api.git',
  ]) {
    assert.match(check(remote), /HTTP\(S\) or SSH URL, or a local path/);
  }
  for (const remote of [
    'https://example.test/org/api.git',
    'SSH://git@example.test/org/api.git',
    'git@example.test:org/api.git',
    'file:///srv/api.git',
    '../api.git',
    '/srv/api.git',
  ]) {
    assert.equal(check(remote), '');
  }
  // Git enforces the same list for clones, including local ones.
  const clone = (remote, failure) =>
    run(
      base,
      'git',
      [...TRANSPORTS, 'clone', '-q', '--', remote, path.join(base, 'clone')],
      failure,
    );
  assert.match(
    clone('helper::payload', true),
    /transport 'helper' not allowed/,
  );
  clone(source('local'));
});

test('configs reject invalid names, duplicate IDs, and malformed fields', () => {
  const api = { remote: 'git@example.test:org/api.git' };
  for (const [values, message] of [
    [{ projects: { '.api': api } }, /Invalid name ".api"/],
    [{ projects: { '-api': api } }, /Invalid name "-api"/],
    [{ projects: { '..': api } }, /Invalid name ".."/],
    [{ groups: { 'my team': {} } }, /Invalid name "my team"/],
    [{ groups: { 'a/b': {} } }, /Invalid name "a\/b"/],
    [{ projects: { 'AGENTS.md': api } }, /"AGENTS.md". Ultrahome and agents/],
    [{ projects: { 'claude.md': api } }, /"claude.md". Ultrahome and agents/],
    [
      { projects: { api }, groups: { team: { projects: ['.api'] } } },
      /Invalid name ".api"/,
    ],
    [{ projects: { api, API: api } }, /api and API differ only in letter case/],
    [
      { projects: { Team: api }, groups: { team: {} } },
      /Team and team differ only in letter case/,
    ],
    [
      {
        projects: { api },
        groups: { team: { projects: ['api'], groups: { API: {} } } },
      },
      /team\/api and team\/API differ only in letter case/,
    ],
    [
      { projects: { api }, groups: { team: { projects: ['api', 'api'] } } },
      /list of unique project IDs/,
    ],
    [{ projects: [] }, /projects must be an object/],
    [{ projects: { api: { remote: ' ' } } }, /api requires a Git clone URL/],
    [{ projects: { api: { ...api, baseBranch: '' } } }, /invalid baseBranch/],
    [{ projects: { api: { ...api, baseBranch: '-x' } } }, /invalid baseBranch/],
    [{ projects: { api: { ...api, baseBranch: 1 } } }, /invalid baseBranch/],
  ]) {
    assert.match(layoutError(values), message);
  }
});

test('errors escape control characters from configs', (t) => {
  const { home, command } = fixture(t);
  fs.writeFileSync(
    path.join(home, '.ultrahome.json'),
    '{"version":1,"\\u001b]0;title\\u0007":1}',
  );
  const output = command('validate', { failure: true });
  assert.match(output, /unexpected field "\\u001b\]0;title\\u0007"/);
  assert.doesNotMatch(output, /[\x1b\x07]/);
});

test('names can use capitals and dots, as repository names do', (t) => {
  const { home, git, commit, source, config, command, ultrahome } = fixture(t);
  config({
    projects: {
      'Next.js': { remote: source('next.js') },
      'site.v2': { remote: source('site.v2') },
    },
    groups: {
      'Web.App': { projects: ['Next.js'] },
      v1_2: { projects: ['site.v2'] },
    },
  });
  command('setup');
  command('validate');
  for (const [group, id] of [
    ['Web.App', 'Next.js'],
    ['v1_2', 'site.v2'],
  ])
    assert.equal(
      fs.readFileSync(path.join(home, group, id, 'README.md'), 'utf8'),
      `# ${id.toLowerCase()}\n`,
    );
  // Git ignores each path exactly, with dots taken literally.
  commit(home);
  assert.equal(git(home, 'status', '--short', '--ignored=no'), '');
  assert.match(
    fs.readFileSync(path.join(home, '.gitignore'), 'utf8'),
    /^\/Next\.js\n\/Web\.App\/Next\.js\n\/site\.v2\n\/v1_2\/site\.v2$/m,
  );
  ultrahome(['remove', 'Web.App/Next.js']);
  command('validate');
});
