import * as fs from 'node:fs';
import path from 'node:path';
import { pathInHome, stat } from './filesystem.mjs';
import { git } from './git.mjs';

const START = '# BEGIN ULTRAHOME MANAGED PATHS';
const END = '# END ULTRAHOME MANAGED PATHS';

// Git ignores all of .ultrahome. These are the local files to verify.
const localPaths = ['.ultrahome/state.json', '.ultrahome/lock'];

export function exposedPaths(root, entries) {
  const paths = new Set(
    [...localPaths, ...entries].map((entry) => entry.split(path.sep).join('/')),
  );
  const result = git(
    root,
    ['check-ignore', '--stdin', '-z'],
    false,
    [...paths].join('\0') + '\0',
  );
  // Git exits with 1 when none of the paths are ignored.
  if (result.status !== 0 && result.status !== 1)
    throw new Error(result.stderr.trim() || 'Could not check Git ignore rules');
  for (const entry of result.stdout.split('\0')) paths.delete(entry);
  return paths;
}

const patterns = (entries, prefix) =>
  [...entries].sort().map((entry) => prefix + entry.split(path.sep).join('/'));

// Returns `name` at the home root with its managed block set to `lines`,
// keeping everything outside the block.
function managedFile(root, name, lines) {
  const file = pathInHome(root, name);
  const original = stat(file) ? fs.readFileSync(file, 'utf8') : '';
  const begin = original.indexOf(START);
  const end = original.indexOf(END);
  if (
    (begin === -1) !== (end === -1) ||
    end < begin ||
    begin !== original.lastIndexOf(START) ||
    end !== original.lastIndexOf(END)
  ) {
    throw new Error(`Fix the Ultrahome markers in ${name}`);
  }
  const managed = [START, ...lines, END].join('\n');
  if (begin >= 0)
    return (
      original.slice(0, begin) + managed + original.slice(end + END.length)
    );
  return (
    original +
    (original && !original.endsWith('\n') ? '\n' : '') +
    managed +
    '\n'
  );
}

export function checkedIgnore(root, entries = []) {
  return managedFile(root, '.gitignore', [
    '/.ultrahome/',
    // Atomic writes stage next to the file, including beside each group's
    // Claude Code settings.
    '.ultrahome-write-*',
    ...patterns(entries, '/'),
  ]);
}

// ripgrep, fd, and the agent tools built on them skip what .gitignore lists,
// which would hide every checkout and link. Their `.ignore` file takes
// precedence, so it lists the same paths again as exceptions. Git doesn't
// read it.
export function searchIgnore(root, entries = []) {
  return managedFile(root, '.ignore', [
    '# Lets search tools such as ripgrep see the projects that .gitignore hides.',
    ...patterns(entries, '!/'),
  ]);
}
