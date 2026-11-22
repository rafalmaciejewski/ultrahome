import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { exists, fixture } from './helpers.mjs';

test('remove deletes a link, keeps its checkout and formatting, and updates ignores', (t) => {
  const { home, git, read, source, ultrahome, command } = fixture(t);
  const remote = JSON.stringify(source('remote'));
  fs.writeFileSync(
    path.join(home, '.ultrahome.json'),
    `{
  "version": 1,
  "projects": { "a": { "remote": ${remote} } },
  "groups": {
    "team": { "projects": ["a"] },
    "other": { "projects": ["a"] }
  }
}
`,
  );
  command('setup');
  // Another group still links the checkout.
  assert.doesNotMatch(ultrahome(['remove', 'team/a']), /Kept/);
  const text = read();
  assert(text.includes('    "other": { "projects": ["a"] }\n'), text);
  assert.deepEqual(JSON.parse(text).groups, {
    team: { projects: [] },
    other: { projects: ['a'] },
  });
  assert(!exists(path.join(home, 'team/a')));
  assert(fs.lstatSync(path.join(home, 'other/a')).isSymbolicLink());
  assert(fs.lstatSync(path.join(home, 'a')).isDirectory());
  assert.doesNotMatch(read('', '.gitignore'), /team\/a/);
  assert.doesNotMatch(read('', '.ignore'), /team\/a/);
  command('validate');

  // From a group directory, with the trailing slash shells complete, and
  // through the rm alias. The last link to a checkout says how to delete it.
  assert.match(
    ultrahome(['rm', 'a/'], { dir: path.join(home, 'other') }),
    /Kept the checkout at a\. To delete it, run npx ultrahome remove a/,
  );
  assert(!exists(path.join(home, 'other/a')));
  command('validate');
  assert.equal(git(home, 'check-ignore', 'a'), 'a');
});

test('remove keeps the checkout and says how to delete it', (t) => {
  const { home, git, read, source, config, ultrahome, command } = fixture(t);
  config({ projects: { busy: { remote: source('source-busy') } } });
  command('setup');
  const notes = path.join(home, 'busy/notes.txt');
  fs.writeFileSync(notes, 'work in progress\n');
  assert.match(
    ultrahome(['remove', 'busy']),
    /busy is no longer in \.ultrahome\.json, and Ultrahome doesn't delete checkouts\. Push or copy anything you need from it, then run rm -rf busy\./,
  );
  assert.deepEqual(JSON.parse(read()).projects, {});
  assert.equal(fs.readFileSync(notes, 'utf8'), 'work in progress\n');
  // The kept checkout stays ignored and guarded until it's gone.
  assert.equal(git(home, 'check-ignore', 'busy'), 'busy');
  assert.match(command('validate'), /then run rm -rf busy/);
  fs.rmSync(path.join(home, 'busy'), { recursive: true });
  command('setup');
  assert.doesNotMatch(read('', '.gitignore'), /busy/);
  command('validate');
});

test('remove refuses what other entries depend on and leaves the config untouched', (t) => {
  const { home, read, source, config, ultrahome, command } = fixture(t);
  config({
    projects: {
      a: { remote: source('remote') },
      b: { remote: source('source-b') },
    },
    groups: {
      other: { projects: ['a'] },
      team: { groups: { sub: { projects: ['a', 'b'] } } },
    },
  });
  command('setup');
  const before = read();
  const failures = [
    [['remove', 'a'], /Groups link to a: other\/a, team\/sub\/a/],
    [['remove', 'b'], /Groups link to b: team\/sub\/b\. Remove those links/],
    [['remove', 'team'], /team is a group/],
    [['remove', 'missing'], /missing is not a project/],
    [['remove', '../a'], /Invalid project path/],
  ];
  for (const [args, message] of failures)
    assert.match(ultrahome(args, { failure: true }), message);
  assert.equal(read(), before);
  assert(fs.lstatSync(path.join(home, 'team/sub/a')).isSymbolicLink());
  command('validate');
});
