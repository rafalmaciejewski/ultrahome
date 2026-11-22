import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { sameRemote } from './config.mjs';
import { stat } from './filesystem.mjs';

// The transports Git may clone projects over. Git's default allows any
// installed remote helper (`<name>::<address>`) for user-typed URLs, but
// these come from configs other people commit.
export const TRANSPORTS = [
  'protocol.allow=never',
  'protocol.file.allow=always',
  'protocol.http.allow=always',
  'protocol.https.allow=always',
  'protocol.ssh.allow=always',
].flatMap((setting) => ['-c', setting]);

// Variables that tie Git to one repository (from `git rev-parse
// --local-env-vars`, minus the config ones, which carry user settings such as
// CI credentials). Git exports them to hooks, so running Ultrahome from a hook
// would otherwise aim every command at that hook's repository.
const REPOSITORY_ENV = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_GRAFT_FILE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
]);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !REPOSITORY_ENV.has(name)),
);

export function git(cwd, args, check = true, input) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env,
    input,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (check && result.status !== 0) {
    throw new Error(result.stderr.trim() || `Git command failed: ${args[0]}`);
  }
  return result;
}

// Starts Git without waiting for it, with `extra` added to its environment.
export function startGit(cwd, args, { env: extra, ...options } = {}) {
  return spawn('git', ['-C', cwd, ...args], {
    ...options,
    env: { ...env, ...extra },
  });
}

// The remotes of the checkout at `checkout`, as [name, URL] pairs. Empty if
// it isn't the top of a Git checkout.
export function remotes(checkout) {
  if (
    !stat(checkout)?.isDirectory() ||
    !stat(path.join(checkout, '.git'))?.isDirectory()
  )
    return [];
  const result = git(
    checkout,
    ['config', '--local', '-z', '--get-regexp', String.raw`^remote\..*\.url$`],
    false,
  );
  // Each record is `remote.<name>.url`, a newline, and the URL.
  return result.stdout
    .split('\0')
    .filter((record) => record.includes('\n'))
    .map((record) => {
      const [key, url] = record.split(/\n(.*)/s);
      return [key.slice('remote.'.length, -'.url'.length), url];
    });
}

// The name of a remote in `checkout` for the repository at `remote`, so a
// teammate's fork setup (the project as `upstream`, a fork as `origin`) or a
// switch from HTTPS to SSH still counts as the configured checkout.
export function matchingRemote(checkout, remote) {
  return remotes(checkout).find(([, url]) => sameRemote(url, remote))?.[0];
}
