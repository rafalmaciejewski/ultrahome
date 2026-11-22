import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import { cloneOutput } from '../src/clone.mjs';
import { LiveProgress } from '../src/progress.mjs';
import { cli, exists, fixture, run } from './helpers.mjs';

test('setup clones more projects than it runs at once', (t) => {
  const { home, source, config, command } = fixture(t);
  const ids = Array.from({ length: 8 }, (_, index) => `project-${index}`);
  config({
    projects: Object.fromEntries(
      ids.map((id) => [id, { remote: source(`source-${id}`) }]),
    ),
    groups: { team: { projects: ids } },
  });
  const output = command('setup');
  for (const id of ids) {
    assert.match(output, new RegExp(`^Cloning ${id}\\.\\.\\.$`, 'm'));
    assert.match(output, new RegExp(`^Cloned ${id}$`, 'm'));
    assert(fs.statSync(path.join(home, id, '.git')).isDirectory());
  }
  command('validate');
});

test(
  'a signal stops the clones and leaves no lock or partial checkout',
  { timeout: 20000 },
  async (t) => {
    const { base, home, source, config, command } = fixture(t);
    config({
      projects: {
        a: { remote: source('source-a') },
        b: { remote: source('source-b') },
      },
    });
    // A git whose clones hang, recording their process IDs.
    const bin = path.join(base, 'bin');
    const pids = path.join(base, 'pids');
    const realGit = run(base, 'sh', ['-c', 'command -v git']);
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'git'),
      `#!/bin/sh\ncase " $* " in *" clone "*) echo $$ >> '${pids}'; exec sleep 60 ;; esac\nexec '${realGit}' "$@"\n`,
      { mode: 0o755 },
    );
    const child = spawn(process.execPath, [cli, 'setup'], {
      cwd: home,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      },
    });
    let output = '';
    child.stdout.on('data', (data) => (output += data));
    child.stderr.on('data', (data) => (output += data));
    const exit = once(child, 'exit');
    const started = () =>
      exists(pids) ? fs.readFileSync(pids, 'utf8').trim().split('\n') : [];
    while (started().length < 2) await sleep(20);
    child.kill('SIGINT');
    const [code] = await exit;
    assert.equal(code, 130, output);
    assert.match(output, /Stopped cloning\. Run npx ultrahome setup/);
    for (const pid of started())
      assert.throws(() => process.kill(Number(pid), 0), { code: 'ESRCH' });
    const left = fs.readdirSync(path.join(home, '.ultrahome'));
    assert.deepEqual(
      left.filter((name) => name !== 'state.json'),
      [],
    );
    assert(!exists(path.join(home, 'a')));
    command('setup');
    assert(exists(path.join(home, 'a/.git')));
  },
);

test('clone output becomes progress updates and an error message', () => {
  const updates = [];
  const output = cloneOutput((status) => updates.push(status));
  output.write("Cloning into '/home/.ultrahome/.staging-x/checkout'...\n");
  output.write('remote: Enumerating objects: 9, done.\nremote: Total 9 (de');
  output.write('lta 0), reused 0 (delta 0)\nReceiving objects:  50% (4/9)\r');
  output.write('Receiving objects: 100% (9/9), 1.20 MiB | 3.10 MiB/s, done.\n');
  output.write('Resolving deltas:  50% (1/2)\rwarning: odd\nfatal: gone');
  assert.deepEqual(
    updates.map(({ phase, percent, detail }) => [phase, percent, detail]),
    [
      ['Enumerating objects', undefined, undefined],
      ['Receiving objects', 50, undefined],
      ['Receiving objects', 100, '1.20 MiB | 3.10 MiB/s'],
      ['Resolving deltas', 50, undefined],
    ],
  );
  assert.deepEqual(
    updates.map(({ fraction }) => fraction),
    [0, 0.4, 0.8, 0.875],
  );
  assert.equal(output.message(), 'warning: odd\nfatal: gone');
});

test('live progress fits the terminal and logs finished clones', () => {
  const frames = [];
  const stream = new Writable({
    write(chunk, encoding, callback) {
      frames.push(chunk.toString());
      callback();
    },
  });
  Object.assign(stream, { isTTY: true, columns: 40 });
  const progress = new LiveProgress(
    ['payments', 'a-project-with-a-very-long-name'],
    stream,
  );
  progress.start('payments');
  progress.start('a-project-with-a-very-long-name');
  progress.update('payments', {
    phase: 'Receiving objects',
    percent: 42,
    detail: '1.20 MiB | 3.10 MiB/s',
    fraction: 0.5,
  });
  progress.draw();
  progress.finish('a-project-with-a-very-long-name', true);
  progress.stop();
  const screens = frames.map((frame) =>
    stripVTControlCharacters(frame).replaceAll('\r', '').split('\n'),
  );
  for (const line of screens.flat()) assert(line.length < 40, line);
  assert.deepEqual(screens[3], [
    '⠹ Cloning projects ━━━━━━─────────────…',
    '  payments              Receiving obje…',
    '  a-project-with-a-ve…  Connecting',
    '',
  ]);
  assert.deepEqual(screens[4].slice(0, 2), [
    'Cloned a-project-with-a-very-long-name',
    '⠸ Cloning projects ━━━━━━━━━━━━━━━━━━─…',
  ]);
  assert.equal(frames.at(-1).endsWith('\x1b[?25h'), true);
});
