import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { LOCAL_SETTINGS } from './agents.mjs';
import { META } from './config.mjs';
import { atomic, stat } from './filesystem.mjs';
import { git } from './git.mjs';

// Git deletes or overwrites ignored files to check out a commit that tracks
// their paths, so a home commit that tracks a checkout's path would destroy
// the checkout, unpushed work included, on the next pull. This hook refuses
// ref updates to such commits. A fetch updates refs before anything is
// checked out, so pull, fetch, and gh pr checkout stop in time. The same
// goes for the ignored files Ultrahome keeps in the home: its local state,
// and the home's local Claude Code settings, which hold each teammate's own
// permissions and the worktree base that keeps Claude Code from fetching past
// this guard.
//
// Each home lists its managed paths, relative to its root, in the Git
// directory. A path only counts while it exists, so moving a
// checkout aside lets the commit through. Paths compare case-insensitively
// because a case-insensitive filesystem treats Payments as payments.
const MARKER = '# Ultrahome fetch guard';
const HOOK = String.raw`#!/bin/sh
${MARKER}, installed and updated by ultrahome setup.
# Refuses ref updates to commits that track a path where Ultrahome keeps a
# checkout, link, or local file, or replace a directory above one, because
# checking out such a commit deletes or overwrites what's there.
[ "$1" = prepared ] || exit 0
guard="$(git rev-parse --git-common-dir)/ultrahome/guard"
[ -d "$guard" ] || exit 0
ULTRAHOME_MANAGED=$(for list in "$guard"/*; do
  [ -f "$list" ] || continue
  root=$(head -n 1 "$list")
  tail -n +2 "$list" | while IFS= read -r entry; do
    if [ -e "$root/$entry" ] || [ -L "$root/$entry" ]; then
      printf '%s\n' "$entry"
    fi
  done
done | tr 'A-Z' 'a-z')
[ -n "$ULTRAHOME_MANAGED" ] || exit 0
export ULTRAHOME_MANAGED
# A refused branch stops the whole fetch, and with it git pull, even when it
# isn't the current branch. Pulling the current branch by name fetches only it.
branch=$(git symbolic-ref -q HEAD)
upstream=$(git rev-parse --symbolic-full-name '@{upstream}' 2>/dev/null)
name=$(git symbolic-ref -q --short HEAD)
remote=$(git config "branch.$name.remote" 2>/dev/null)
merge=$(git config "branch.$name.merge" 2>/dev/null | sed 's|^refs/heads/||')
if [ -n "$name" ] && [ -n "$remote" ] && [ -n "$merge" ]; then
  pull="git pull $remote $merge"
else
  pull="git pull <remote> <branch>"
fi
while read -r old new ref; do
  tree=$(git rev-parse -q --verify "$new^{tree}" 2>/dev/null) || continue
  hit=$(git ls-tree -r -t --full-tree "$tree" | tr 'A-Z' 'a-z' | awk '
    BEGIN { FS = "\t"; n = split(ENVIRON["ULTRAHOME_MANAGED"], managed, "\n") }
    {
      split($1, meta, " ")
      for (i = 1; i <= n; i++)
        if ($2 == managed[i] || index($2, managed[i] "/") == 1 ||
            (meta[2] != "tree" && index(managed[i], $2 "/") == 1)) {
          print $2
          exit
        }
    }')
  if [ -n "$hit" ]; then
    case "$ref" in
      HEAD | "$branch" | "$upstream")
        echo "ultrahome: refused to update $ref. Its commit tracks $hit, and checking it out would delete or overwrite a checkout, link, or local file that Ultrahome manages. Push or copy anything you need from there and move it out of the home before fetching this commit." >&2
        ;;
      *)
        echo "ultrahome: refused to update $ref. Its commit tracks $hit, and checking it out would delete or overwrite a checkout, link, or local file that Ultrahome manages. Your current branch isn't affected: update it with $pull. To fetch $ref, remove $hit from that branch or delete it." >&2
        ;;
    esac
    exit 1
  fi
done
`;

function read(file) {
  return stat(file) ? fs.readFileSync(file, 'utf8') : undefined;
}

function locate(root) {
  const [common, hooks] = git(root, [
    'rev-parse',
    '--git-common-dir',
    '--git-path',
    'hooks',
  ])
    .stdout.trimEnd()
    .split('\n');
  const commonDir = path.resolve(root, common);
  const hookDir = path.join(commonDir, 'hooks');
  const id = createHash('sha256').update(root).digest('hex').slice(0, 16);
  return {
    hook: path.join(hookDir, 'reference-transaction'),
    list: path.join(commonDir, 'ultrahome', 'guard', id),
    // Set when core.hooksPath sends Git somewhere else for hooks.
    hooksPath:
      path.resolve(root, hooks) === hookDir
        ? undefined
        : path.resolve(root, hooks),
  };
}

// The home's root, then the paths it manages. The hook compares them with
// the paths in a commit's tree, since the root is the repository's top level.
function managedList(root, state) {
  const entries = new Set([
    META,
    LOCAL_SETTINGS,
    ...state.repos.keys(),
    ...state.links.keys(),
  ]);
  return [root, ...[...entries].sort()].join('\n') + '\n';
}

// Why Git won't run the guard, or '' if it will.
function blocker({ hook, hooksPath }) {
  if (hooksPath) return `core.hooksPath makes Git run hooks from ${hooksPath}`;
  if (stat(hook) && !read(hook).includes(MARKER))
    return `another hook is already installed at ${hook}`;
  return '';
}

export function syncGuard(root, state) {
  const location = locate(root);
  const list = managedList(root, state);
  if (read(location.list) !== list) {
    fs.mkdirSync(path.dirname(location.list), { recursive: true });
    atomic(location.list, list);
  }
  if (!blocker(location) && read(location.hook) !== HOOK) {
    fs.mkdirSync(path.dirname(location.hook), { recursive: true });
    atomic(location.hook, HOOK, 0o755);
  }
}

// An issue setup can fix, or a warning about a guard Git won't run.
export function checkGuard(root, state) {
  const location = locate(root);
  const reason = blocker(location);
  if (reason) {
    return {
      warning: `Git won't run Ultrahome's fetch guard: ${reason}. Until it does, pulling a home commit that tracks a checkout's path deletes that checkout. See https://github.com/rafalmaciejewski/ultrahome/blob/main/docs/security.md`,
    };
  }
  if (
    read(location.hook) !== HOOK ||
    read(location.list) !== managedList(root, state)
  ) {
    return {
      issue: 'The fetch guard is missing or stale. Run npx ultrahome setup.',
    };
  }
  return {};
}
