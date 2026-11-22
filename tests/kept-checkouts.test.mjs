import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { exists, fixture } from './helpers.mjs';

// Ultrahome never deletes checkouts. One the config drops stays ignored and
// guarded, and setup and validate say how to delete it, until it's gone.
test('setup keeps a checkout the config drops until the user deletes it', (t) => {
  const { home, git, read, source, config, command } = fixture(t);
  config({
    projects: { a: { remote: source('remote') } },
    groups: { team: { projects: ['a'] } },
  });
  command('setup');
  const checkout = path.join(home, 'a');
  // Work Git doesn't track, such as installed dependencies and notes.
  fs.mkdirSync(path.join(checkout, 'node_modules'));
  const notes = path.join(checkout, 'notes.txt');
  fs.writeFileSync(notes, 'work in progress\n');

  config({});
  const kept =
    /a is no longer in \.ultrahome\.json, and Ultrahome doesn't delete checkouts\. Push or copy anything you need from it, then run rm -rf a\./;
  assert.match(command('setup'), kept);
  assert.equal(fs.readFileSync(notes, 'utf8'), 'work in progress\n');
  assert(!exists(path.join(home, 'team/a')));
  assert.equal(git(home, 'check-ignore', 'a'), 'a');
  const guard = path.join(home, '.git/ultrahome/guard');
  const [list] = fs.readdirSync(guard);
  assert.match(fs.readFileSync(path.join(guard, list), 'utf8'), /^a$/m);
  assert.match(command('validate'), kept);

  fs.rmSync(checkout, { recursive: true });
  assert.match(
    command('validate', { failure: true }),
    /Obsolete project path a\. Run npx ultrahome setup/,
  );
  assert.doesNotMatch(command('setup'), kept);
  assert.doesNotMatch(read('', '.gitignore'), /^\/a$/m);
  assert.deepEqual(JSON.parse(read('.ultrahome', 'state.json')).repos, {});
  command('validate');
});
