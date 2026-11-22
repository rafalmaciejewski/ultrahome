import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { addProject, cli, fixture, run } from './helpers.mjs';

test('add clones projects at the home root and links them into groups', (t) => {
  const { home, base, git, commit, source, command } = fixture(t);
  const local = source('remote');
  const api = 'https://example.test/org/api.git';
  const web = 'git@example.test:org/web.git';
  addProject(home, api, 'api', local);
  addProject(home, api, 'team/api', local);
  const layout = JSON.parse(
    fs.readFileSync(path.join(home, '.ultrahome.json'), 'utf8'),
  );
  assert.deepEqual(layout.groups.team.projects, ['api']);
  // From a group directory, the path is relative to that group.
  addProject(path.join(home, 'team'), web, 'frontend/web', local);
  for (const id of ['api', 'web'])
    assert.equal(
      fs.realpathSync(
        path.join(home, id === 'api' ? 'team' : 'team/frontend', id),
      ),
      path.join(home, id),
    );
  assert.equal(
    git(path.join(home, 'web'), 'config', '--get', 'remote.origin.url'),
    web,
  );
  command('validate');

  const config = path.join(home, '.ultrahome.json');
  const previous = fs.readFileSync(config, 'utf8');
  addProject(home, web, 'team/frontend/web', local);
  assert.match(
    addProject(home, api, 'team/frontend/web', local, true),
    /another source/,
  );
  assert.equal(fs.readFileSync(config, 'utf8'), previous);

  commit(home);
  const joined = path.join(base, 'joined');
  git(base, 'clone', home, joined);
  const env = { ...process.env, GIT_CONFIG_COUNT: '2' };
  for (const [i, url] of [api, web].entries()) {
    env[`GIT_CONFIG_KEY_${i}`] = `url.${local}.insteadOf`;
    env[`GIT_CONFIG_VALUE_${i}`] = url;
  }
  run(joined, process.execPath, [cli, 'setup'], false, env);
  command('validate', { dir: joined });
});

test('add keeps the formatting and key order of the config', (t) => {
  const { home, read, source, command } = fixture(t);
  const local = source('remote');
  const url = 'https://example.test/org/api.git';
  fs.writeFileSync(
    path.join(home, '.ultrahome.json'),
    `{
  "groups": {
    "other": { "projects": [] },
    "team": { "projects": [] }
  },
  "version": 1,
  "projects": {}
}
`,
  );
  addProject(home, url, 'api', local);
  addProject(home, url, 'team/api', local);
  addProject(home, url, 'team/sub/api', local);
  const text = read();
  assert(text.includes('    "other": { "projects": [] },\n'), text);
  assert.deepEqual(Object.keys(JSON.parse(text)), [
    'groups',
    'version',
    'projects',
  ]);
  assert.deepEqual(JSON.parse(text), {
    version: 1,
    projects: { api: { remote: url } },
    groups: {
      other: { projects: [] },
      team: {
        projects: ['api'],
        groups: { sub: { projects: ['api'] } },
      },
    },
  });
  command('setup');
});

test('Git ignores staging that interrupted writes leave behind', (t) => {
  const { home, git, config, command } = fixture(t);
  config({ groups: { team: {} } });
  command('setup');
  // Writes stage next to the file: at the home root, and beside the Claude
  // Code settings of the home and each group.
  for (const dir of [
    '.ultrahome-write-x',
    '.claude/.ultrahome-write-x',
    'team/.claude/.ultrahome-write-x',
  ])
    fs.mkdirSync(path.join(home, dir, 'file'), { recursive: true });
  assert.doesNotMatch(
    git(home, 'status', '--porcelain', '--untracked-files=all'),
    /ultrahome-write/,
  );
});

test('add from a group directory registers the project at the root and links it there', (t) => {
  const { home, source, config } = fixture(t);
  const local = source('remote');
  config({ groups: { other: {}, team: { groups: { sub: {} } } } });
  const read = () =>
    JSON.parse(fs.readFileSync(path.join(home, '.ultrahome.json'), 'utf8'));
  fs.mkdirSync(path.join(home, 'team/sub'), { recursive: true });
  addProject(path.join(home, 'team'), 'https://example.test/a.git', 'a', local);
  addProject(
    path.join(home, 'team/sub'),
    'https://example.test/b.git',
    'b',
    local,
  );
  assert.deepEqual(read(), {
    version: 1,
    groups: {
      other: {},
      team: { projects: ['a'], groups: { sub: { projects: ['b'] } } },
    },
    projects: {
      a: { remote: 'https://example.test/a.git' },
      b: { remote: 'https://example.test/b.git' },
    },
  });
  assert.equal(fs.readlinkSync(path.join(home, 'team/a')), '../a');
  assert.equal(fs.readlinkSync(path.join(home, 'team/sub/b')), '../../b');
});

test('add and remove resolve ./, .., and absolute paths from the current directory', (t) => {
  const { home, source, config, read, ultrahome } = fixture(t);
  const local = source('remote');
  config({ groups: { team: {}, other: {} } });
  const team = path.join(home, 'team');
  addProject(home, 'https://example.test/a.git', './team/a', local);
  addProject(team, 'https://example.test/b.git', '../other/b/', local);
  addProject(team, 'https://example.test/c.git', path.join(team, 'c'), local);
  const groups = () => JSON.parse(read()).groups;
  assert.deepEqual(groups(), {
    team: { projects: ['a', 'c'] },
    other: { projects: ['b'] },
  });
  assert.equal(fs.readlinkSync(path.join(home, 'other/b')), '../b');
  ultrahome(['rm', './a'], { dir: team });
  ultrahome(['rm', '../other/b'], { dir: team });
  assert.deepEqual(groups(), {
    team: { projects: ['c'] },
    other: { projects: [] },
  });
  assert.match(
    ultrahome(['rm', '.'], { dir: team, failure: true }),
    /team is a group/,
  );
});

test('add keeps existing links and retries failed clones', (t) => {
  const { home, base, read, source, config, command } = fixture(t);
  config({
    projects: { existing: { remote: source('original') } },
    groups: { division: { groups: { team: { projects: ['existing'] } } } },
  });
  const url = 'ssh://git@example.test:2222/org/api.git';
  const local = path.join(base, 'later');
  addProject(home, url, 'division/team/api', local, true);
  assert(!fs.existsSync(path.join(home, 'existing')));
  source('later');
  addProject(home, url, 'division/team/api', local);
  const layout = JSON.parse(read());
  assert.deepEqual(layout.projects.api, { remote: url });
  assert.deepEqual(layout.groups.division.groups.team.projects, [
    'existing',
    'api',
  ]);
  assert.equal(
    fs.realpathSync(path.join(home, 'division/team/api')),
    path.join(home, 'api'),
  );
  command('setup');
  assert.equal(
    fs.realpathSync(path.join(home, 'division/team/existing')),
    path.join(home, 'existing'),
  );
  command('validate');
});

test('invalid add arguments and occupied paths leave the config untouched', (t) => {
  const { home, config, ultrahome } = fixture(t);
  config({
    projects: { api: { remote: '../unavailable' } },
    groups: { team: {} },
  });
  const file = path.join(home, '.ultrahome.json');
  const previous = fs.readFileSync(file, 'utf8');
  const url = 'http://example.test/org/api.git';
  for (const [args, message] of [
    [[url, 'api/sub'], /api is a project, not a group/],
    [[url, 'team/api'], /already has a project api from another source/],
    [['../unavailable', 'other'], /already has this repository as api/],
  ])
    assert.match(ultrahome(['add', ...args], { failure: true }), message);
  for (const args of [
    [url],
    ['', 'api'],
    ['helper::payload', 'api'],
    ['ftp://host/repo', 'api'],
    [url, '.'],
    [url, '../x'],
    [url, '/api'],
    [url, 'team'],
  ]) {
    run(home, process.execPath, [cli, 'add', ...args], true);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), previous);
});

test('add and configs reject URL credentials without storing or echoing them', (t) => {
  const { home, command } = fixture(t);
  const config = path.join(home, '.ultrahome.json');
  const before = fs.readFileSync(config, 'utf8');
  for (const url of [
    'http://user:private-token@example.test/org/api.git',
    'https://private-token@example.test/org/api.git',
    'ssh://git:private-token@example.test/org/api.git',
  ]) {
    const message = run(
      home,
      process.execPath,
      [cli, 'add', url, 'team/api'],
      true,
    );
    assert.match(message, /credential helper or SSH/);
    assert.doesNotMatch(message, /private-token/);
    assert.equal(fs.readFileSync(config, 'utf8'), before);
    assert(!fs.existsSync(path.join(home, '.ultrahome/state.json')));

    // The same URL in a hand-edited config.
    fs.writeFileSync(
      config,
      JSON.stringify({ version: 1, projects: { api: { remote: url } } }),
    );
    const output = command('setup', { failure: true });
    assert.match(output, /credential helper or SSH/);
    assert.doesNotMatch(output, /private-token/);
    assert(!fs.existsSync(path.join(home, 'api')));
    fs.writeFileSync(config, before);
  }
});

test('add accepts local paths and every URL form a config accepts', (t) => {
  const { home, read, source, ultrahome, command } = fixture(t);
  const [a, , c, d] = ['a', 'b', 'c', 'd'].map((id) => source(`local-${id}`));
  const local = a;
  const team = path.join(home, 'team');
  fs.mkdirSync(team);
  // A relative path is relative to where add runs, and the config stores it
  // relative to the home root, where setup resolves it.
  ultrahome(['add', '../local-a', 'a']);
  ultrahome(['add', path.join('..', '..', 'local-b'), 'b'], { dir: team });
  ultrahome(['add', c, 'c']);
  ultrahome(['add', `file://${d}`, 'd']);
  const config = JSON.parse(read());
  assert.deepEqual(config.projects, {
    a: { remote: '../local-a' },
    b: { remote: '../local-b' },
    c: { remote: c },
    d: { remote: `file://${d}` },
  });
  assert.deepEqual(config.groups.team.projects, ['b']);
  for (const id of ['a', 'b', 'c', 'd'])
    assert.equal(
      fs.readFileSync(path.join(home, id, 'README.md'), 'utf8'),
      `# local-${id}\n`,
    );
  // A repository the home already has is linked, in any URL form, under
  // its ID only.
  ultrahome(['add', `file://${a}`, 'a'], { dir: team });
  assert.match(
    ultrahome(['add', '../../local-a', 'first'], { dir: team, failure: true }),
    /already has this repository as a\. Use that name/,
  );
  assert.deepEqual(JSON.parse(read()).groups.team.projects, ['b', 'a']);
  assert.equal(fs.readlinkSync(path.join(team, 'a')), '../a');
  command('validate');

  for (const url of [
    'ssh+git://git@example.test/org/e.git',
    'git+ssh://git@example.test/org/f.git',
  ]) {
    const id = url.match(/(\w)\.git$/)[1];
    addProject(home, url, id, local);
    assert.deepEqual(JSON.parse(read()).projects[id], { remote: url });
  }
});
