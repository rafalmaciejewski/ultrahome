import * as fs from 'node:fs';
import { uptime } from 'node:os';
import path from 'node:path';
import { META, entries, fields, isName, parseJson } from './config.mjs';
import { atomic, pathInHome, stat } from './filesystem.mjs';
import { git } from './git.mjs';

function assertStopped(owner, lock) {
  if (!/^[1-9][0-9]*$/.test(owner))
    throw new Error(`Invalid lock at ${lock}. Delete it and try again.`);
  // A lock from before the system started is stale, even if a new process
  // now has its PID.
  if (stat(lock)?.mtimeMs < Date.now() - uptime() * 1000) return;
  try {
    process.kill(Number(owner), 0);
  } catch (error) {
    if (error.code === 'ESRCH') return;
    if (error.code !== 'EPERM') throw error;
  }
  throw new Error(
    `Another Ultrahome command is running (PID ${owner}). If none is, delete ${lock} and try again.`,
  );
}

async function withPidLock(lock, operation) {
  const pid = String(process.pid);
  try {
    fs.symlinkSync(pid, lock);
  } catch (error) {
    if (error.code !== 'EEXIST' || !stat(lock)?.isSymbolicLink()) throw error;
    const owner = fs.readlinkSync(lock);
    assertStopped(owner, lock);
    // Only the recovery-lock holder may unlink a dead owner's lock. If it
    // dies during recovery, its own lock can be recovered the same way.
    await withPidLock(`${lock}.recovery`, () => {
      if (fs.readlinkSync(lock) !== owner)
        throw new Error('Ultrahome lock changed. Retry.');
      assertStopped(owner, lock);
      fs.unlinkSync(lock);
      fs.symlinkSync(pid, lock);
    });
  }
  try {
    return await operation();
  } finally {
    fs.unlinkSync(lock);
  }
}

// Git ignores the state directory, and it silently overwrites ignored files
// to check out a commit that tracks them. State or a lock that arrived that
// way came from whoever made the commit.
function assertUntracked(root) {
  const tracked = git(root, ['ls-files', '-z', '--', META], false);
  if (tracked.status === 0 && tracked.stdout) {
    throw new Error(
      `Git tracks ${META} in the home, so its contents may come from someone else. Remove it from the index with git rm -r --cached ${META}, then delete ${META} and run setup`,
    );
  }
}

export async function withLock(root, operation) {
  assertUntracked(root);
  // A fresh clone has no local state directory yet.
  const meta = pathInHome(root, META);
  fs.mkdirSync(meta, { recursive: true });
  return withPidLock(path.join(meta, 'lock'), operation);
}

export function readState(root) {
  assertUntracked(root);
  const file = pathInHome(root, path.join(META, 'state.json'));
  const raw = stat(file) ? parseJson(file) : { repos: {}, links: {} };
  fields(raw, ['repos', 'links'], 'local state');
  const state = {};
  for (const section of ['repos', 'links']) {
    state[section] = new Map(entries(raw[section], section));
    for (const [key, value] of state[section]) {
      // Checkouts sit at the home root, and links in groups.
      const parts = key.split(path.sep);
      const placed =
        section === 'repos' ? parts.length === 1 : parts.length > 1;
      if (!placed || !parts.every(isName) || !validRecord(section, value)) {
        throw new Error(`Invalid managed path or value in local state: ${key}`);
      }
    }
  }
  return state;
}

// A checkout records the remote it was cloned from, and a link its target.
function validRecord(section, value) {
  const validString = (text) =>
    typeof text === 'string' && text.length > 0 && !text.includes('\0');
  if (section === 'links') return validString(value);
  fields(value, ['remote'], 'checkout record');
  return validString(value.remote);
}

export function saveState(root, state) {
  const data = Object.fromEntries(
    Object.entries(state).map(([key, value]) => [
      key,
      Object.fromEntries([...value].sort()),
    ]),
  );
  atomic(
    path.join(root, META, 'state.json'),
    JSON.stringify(data, null, 2) + '\n',
  );
}
