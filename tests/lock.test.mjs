import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { uptime } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fixture, run } from './helpers.mjs';

test('setup respects a live lock and recovers an interrupted lock', (t) => {
  const { base, home, command } = fixture(t);
  const lock = path.join(home, '.ultrahome/lock');
  fs.symlinkSync('not-a-pid', lock);
  assert.match(command('setup', { failure: true }), /Invalid lock/);
  fs.unlinkSync(lock);
  fs.symlinkSync(String(process.pid), lock);
  assert.ok(
    command('setup', { failure: true }).includes(
      `Another Ultrahome command is running (PID ${process.pid}). If none is, delete ${lock} and try again.`,
    ),
  );
  assert.equal(fs.readlinkSync(lock), String(process.pid));
  fs.unlinkSync(lock);
  const stopped = run(base, process.execPath, ['-p', 'process.pid']);
  fs.symlinkSync(stopped, lock);
  fs.symlinkSync(String(process.pid), lock + '.recovery');
  assert.match(
    command('setup', { failure: true }),
    /Another Ultrahome command is running/,
  );
  assert.equal(fs.readlinkSync(lock), stopped);
  fs.unlinkSync(lock + '.recovery');
  fs.symlinkSync(stopped, lock + '.recovery');
  command('setup');
  assert.equal(fs.lstatSync(lock, { throwIfNoEntry: false }), undefined);
  assert.equal(
    fs.lstatSync(lock + '.recovery', { throwIfNoEntry: false }),
    undefined,
  );
});

test('a lock from before the system started is stale', (t) => {
  const { home, command } = fixture(t);
  const lock = path.join(home, '.ultrahome/lock');
  // A running process has the PID, as one can after a restart.
  fs.symlinkSync(String(process.pid), lock);
  const beforeBoot = (Date.now() - uptime() * 1000) / 1000 - 60;
  fs.lutimesSync(lock, beforeBoot, beforeBoot);
  command('setup');
  assert.equal(fs.lstatSync(lock, { throwIfNoEntry: false }), undefined);
});

test(
  'only one contender enters setup after an interrupted lock',
  { timeout: 10000 },
  async (t) => {
    const { home, base, command } = fixture(t);
    const lock = path.join(home, '.ultrahome/lock');
    fs.symlinkSync(run(base, process.execPath, ['-p', 'process.pid']), lock);
    const worker = `
    import { withLock } from ${JSON.stringify(new URL('../src/state.mjs', import.meta.url).href)};
    import { readSync } from 'node:fs';
    process.send('ready');
    process.once('message', () => {
      withLock(process.cwd(), () => {
        process.send('acquired');
        readSync(0, Buffer.alloc(1), 0, 1, null);
      }).catch((error) => process.send(error.message));
    });
  `;
    const children = [1, 2].map(() =>
      spawn(process.execPath, ['--input-type=module', '-e', worker], {
        cwd: home,
        stdio: ['pipe', 'ignore', 'inherit', 'ipc'],
      }),
    );
    t.after(() => children.forEach((child) => child.kill()));
    const exits = children.map((child) => once(child, 'exit'));
    await Promise.all(children.map((child) => once(child, 'message')));
    const outcomes = children.map((child) => once(child, 'message'));
    for (const child of children) child.send('start');
    const messages = (await Promise.all(outcomes)).map(([message]) => message);
    assert.equal(
      messages.filter((message) => message === 'acquired').length,
      1,
      messages.join(', '),
    );
    const winner = children[messages.indexOf('acquired')];
    assert.equal(fs.readlinkSync(lock), String(winner.pid));
    winner.stdin.end('x');
    for (const [code] of await Promise.all(exits)) assert.equal(code, 0);
    command('setup');
  },
);
