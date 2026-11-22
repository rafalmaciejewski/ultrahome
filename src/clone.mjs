import * as fs from 'node:fs';
import { constants } from 'node:os';
import path from 'node:path';
import { META } from './config.mjs';
import { temporary } from './filesystem.mjs';
import { git, startGit, TRANSPORTS } from './git.mjs';
import { cloneProgress } from './progress.mjs';

// How many projects are cloned at once. Clones mostly wait on the network,
// and a few at a time stay well under the connection limits of Git hosts.
const CONCURRENCY = 6;

// Clones in the background can't ask for anything: a detached process has no
// terminal to prompt on, and these turn off Git's and SSH's prompt programs.
// Git's messages stay in English so that its progress can be read.
const BACKGROUND = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS_REQUIRE: 'never',
  LC_ALL: 'C',
};

// What Git and SSH report when a clone needed to ask for credentials, a
// passphrase, or a new host key's confirmation.
const PROMPTED =
  /could not read (?:Username|Password)|Host key verification failed|Permission denied \(/;

// Where each step of a clone starts in its overall progress, and its share.
const STEPS = {
  'Receiving objects': [0, 0.8],
  'Resolving deltas': [0.8, 0.15],
  'Updating files': [0.95, 0.05],
};

// A progress line from `git clone --progress`, such as
// "Receiving objects:  42% (420/1000), 1.20 MiB | 3.10 MiB/s", as its phase,
// percentage, and details. Undefined for other lines.
function progressOf(text) {
  const line = text.replace(/^remote: /, '');
  if (/^Total \d+/.test(line)) return {};
  const [, phase, rest] = /^([A-Z][a-z]+(?: [a-z]+)*): +(.*)$/.exec(line) ?? [];
  const percent = /^(\d+)%/.exec(rest ?? '')?.[1];
  if (percent === undefined && !/^\d+, done\.$/.test(rest)) return undefined;
  return {
    phase,
    percent: percent && Number(percent),
    detail: /\), ([^,]+)/.exec(rest)?.[1],
  };
}

// Reads the output of `git clone --progress`. It passes each progress update
// to `update`, with how far the clone has come as a fraction, and keeps the
// other lines, such as errors, for message().
export function cloneOutput(update = () => {}) {
  let partial = '';
  let fraction = 0;
  const lines = [];
  const read = (text) => {
    const progress = progressOf(text);
    if (progress) {
      const [start, share] = STEPS[progress.phase] ?? [];
      if (start !== undefined && progress.percent !== undefined)
        fraction = Math.max(fraction, start + (share * progress.percent) / 100);
      if (progress.phase) update({ ...progress, fraction });
    } else if (text.trim() && !text.startsWith('Cloning into ')) {
      lines.push(text);
    }
  };
  return {
    // Git rewrites a progress line with a carriage return, and ends it with
    // a newline.
    write(chunk) {
      const parts = (partial + chunk).split(/[\r\n]/);
      partial = parts.pop();
      parts.forEach(read);
    },
    message() {
      read(partial);
      partial = '';
      return lines.join('\n').trim();
    },
  };
}

function cloneArgs(spec, checkout, ...options) {
  const branch = spec.baseBranch ? ['--branch', spec.baseBranch] : [];
  return [
    ...TRANSPORTS,
    'clone',
    ...options,
    ...branch,
    '--',
    spec.remote,
    checkout,
  ];
}

// Clones `spec` to `entry` in the background, reporting progress to
// `update`. Resolves to undefined once cloned, or to why it failed.
function cloneInBackground(root, entry, spec, running, update) {
  return new Promise((resolve) => {
    let dir;
    const finish = (error) => {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
      resolve(error);
    };
    let child;
    try {
      dir = fs.mkdtempSync(path.join(root, META, '.staging-'));
      const args = cloneArgs(spec, path.join(dir, 'checkout'), '--progress');
      child = startGit(root, args, {
        env: BACKGROUND,
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (error) {
      finish(error.message);
      return;
    }
    running.add(child);
    const output = cloneOutput(update);
    let failure;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', output.write);
    child.on('error', (error) => (failure = error.message));
    child.on('close', (code) => {
      running.delete(child);
      if (code !== 0) {
        finish(failure ?? (output.message() || 'Git clone failed'));
        return;
      }
      try {
        fs.renameSync(path.join(dir, 'checkout'), path.join(root, entry));
        finish();
      } catch (error) {
        finish(error.message);
      }
    });
  });
}

// Clones in the foreground, where Git and SSH can prompt on the terminal.
function cloneInForeground(root, entry, spec) {
  temporary(path.join(root, META), '.staging-', (dir) => {
    const checkout = path.join(dir, 'checkout');
    try {
      git(root, cloneArgs(spec, checkout));
    } catch (error) {
      const output = cloneOutput();
      output.write(error.message);
      throw new Error(output.message() || error.message);
    }
    fs.renameSync(checkout, path.join(root, entry));
  });
}

// Clones each [entry, spec] of `projects`, several at once, and calls
// `cloned` as each one lands. Returns why each of the others failed.
export async function cloneProjects(root, projects, cloned) {
  const failures = new Map();
  if (!projects.length) return failures;
  // Background clones don't get the terminal's Ctrl-C, so a signal stops
  // them here, and the command cleans up before it exits. A second signal
  // exits at once.
  const running = new Set();
  let signaled;
  const stop = (signal) => {
    if (signaled) process.exit(128 + constants.signals[signal]);
    signaled = signal;
    for (const child of running) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // It already exited.
      }
    }
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, stop);
  const progress = cloneProgress(projects.map(([entry]) => entry));
  const land = (entry, spec) => {
    try {
      cloned(entry, spec);
    } catch (error) {
      return error.message;
    }
  };
  const queue = [...projects];
  const worker = async () => {
    for (let next; !signaled && (next = queue.shift());) {
      const [entry, spec] = next;
      progress.start(entry);
      const update = (status) => progress.update(entry, status);
      const error =
        (await cloneInBackground(root, entry, spec, running, update)) ??
        land(entry, spec);
      if (error !== undefined) failures.set(entry, error);
      progress.finish(entry, error === undefined);
    }
  };
  try {
    const workers = Math.min(CONCURRENCY, projects.length);
    await Promise.all(Array.from({ length: workers }, worker));
  } finally {
    progress.stop();
    for (const signal of signals) process.off(signal, stop);
  }
  if (signaled) {
    const error = new Error(
      'Stopped cloning. Run npx ultrahome setup to clone the rest.',
    );
    error.exitCode = 128 + constants.signals[signaled];
    throw error;
  }
  // In a terminal, clone the projects that needed to ask for something
  // again, one at a time, so Git and SSH can prompt for each.
  if (!process.stdin.isTTY) return failures;
  for (const [entry, spec] of projects) {
    if (!PROMPTED.test(failures.get(entry) ?? '')) continue;
    console.log(`Cloning ${entry} again, so Git can prompt you...`);
    try {
      cloneInForeground(root, entry, spec);
    } catch (error) {
      failures.set(entry, error.message);
      continue;
    }
    const error = land(entry, spec);
    if (error !== undefined) failures.set(entry, error);
    else {
      failures.delete(entry);
      console.log(`Cloned ${entry}`);
    }
  }
  return failures;
}
