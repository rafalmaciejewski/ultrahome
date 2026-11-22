import * as fs from 'node:fs';
import path from 'node:path';
import { LOCAL_SETTINGS } from './agents.mjs';
import { Layout, ancestors } from './config.mjs';
import { pathInHome, stat } from './filesystem.mjs';
import { git, matchingRemote, remotes } from './git.mjs';
import { checkedIgnore, searchIgnore } from './ignore.mjs';
import { shellQuote } from './report.mjs';
import { readState } from './state.mjs';

export function linkValue(entry, target) {
  return path.relative(path.dirname(entry), target);
}

export function matchesLink(file, value) {
  return stat(file)?.isSymbolicLink() && fs.readlinkSync(file) === value;
}

// The part of the layout that validate checks from `scope`: from the home
// root, all of it, and from a group, its links and subgroups and the
// checkouts its links point to.
export function scopedLayout(layout, scope) {
  if (scope !== '.' && !layout.groups.has(scope))
    throw new Error(
      `${scope} is not a group. Run this from the home root or a group directory.`,
    );
  const within = (entry) =>
    scope === '.' || entry === scope || entry.startsWith(scope + path.sep);
  const links = new Map([...layout.links].filter(([entry]) => within(entry)));
  const targets = new Set(links.values());
  const repos = new Map(
    [...layout.repos].filter(([entry]) => scope === '.' || targets.has(entry)),
  );
  const groups = [...layout.groups].filter(within);
  return { within, links, repos, groups };
}

// The groups that held links in `state` and that the layout no longer has,
// deepest first. Preflight checks that these paths stay inside the home.
export function droppedGroups(layout, state) {
  const links = [...state.links.keys()];
  const depth = (group) => group.split(path.sep).length;
  return [...new Set(links.flatMap(ancestors))]
    .filter((group) => group !== '.' && !layout.groups.has(group))
    .sort((a, b) => depth(b) - depth(a));
}

// The paths the home's .gitignore lists: checkouts and links, including
// dropped ones that are still there, and the home's local Claude Code
// settings. Each group's settings are the home's to commit or ignore.
export function ignoredPaths(layout, state) {
  return new Set([
    ...layout.entries,
    ...layout.repos.keys(),
    ...state.repos.keys(),
    ...state.links.keys(),
    LOCAL_SETTINGS,
  ]);
}

// Whether the obsolete `entry` is a checkout that the layout still uses
// under a name that differs only in case, which a case-insensitive
// filesystem resolves to the same directory.
function renamedInCase(layout, entry) {
  const folded = entry.toLowerCase();
  const before = stat(path.join(layout.root, entry));
  return [...layout.repos.keys()].some((other) => {
    if (other === entry || other.toLowerCase() !== folded) return false;
    const after = stat(path.join(layout.root, other));
    return (
      before && after && before.dev === after.dev && before.ino === after.ino
    );
  });
}

// The checkouts in `within` that the layout dropped but that are still there.
// Ultrahome never deletes checkouts, so these stay ignored and guarded until
// the user deletes them.
export function keptCheckouts(layout, state, within) {
  return [...state.repos.keys()].filter(
    (entry) =>
      !layout.repos.has(entry) &&
      within(entry) &&
      stat(path.join(layout.root, entry)) &&
      !renamedInCase(layout, entry),
  );
}

export function keptMessage(entry) {
  return `${entry} is no longer in .ultrahome.json, and Ultrahome doesn't delete checkouts. Push or copy anything you need from it, then run rm -rf ${shellQuote(entry)}.`;
}

// Why `entry`, which holds something other than a checkout of `remote`,
// can't be used. `recorded` is the remote Ultrahome last saw there.
function occupied(root, entry, remote, recorded) {
  const checkout = path.join(root, entry);
  const found = remotes(checkout);
  if (!found.length)
    return `${entry} is occupied by something other than a Git checkout of ${remote}. Move it out of the home or choose a different project ID`;
  // Point the remote Ultrahome knew at the new URL, so a fork setup keeps
  // its fork.
  const name =
    (recorded && matchingRemote(checkout, recorded)) ??
    (found.some(([name]) => name === 'origin') ? 'origin' : found[0][0]);
  return `${entry} is a Git checkout, but none of its remotes points to ${remote}. If the project moved, run git -C ${entry} remote set-url ${shellQuote(name)} ${shellQuote(remote)}. Otherwise move the checkout out of the home or choose a different project ID`;
}

function preflight(layout, state) {
  const { root } = layout;
  for (const group of layout.groups) {
    const info = stat(pathInHome(root, group));
    if (info && !info.isDirectory())
      throw new Error(`${group} must be a directory`);
    if (group !== '.' && stat(path.join(root, group, '.git'))) {
      throw new Error(
        `${group} is a Git checkout and cannot be used as a group`,
      );
    }
  }
  const projectPaths = ignoredPaths(layout, state);
  for (const entry of projectPaths) {
    pathInHome(root, path.dirname(entry));
    for (const parent of ancestors(entry)) {
      if (parent !== '.' && stat(path.join(root, parent, '.git'))) {
        throw new Error(`${entry} is inside the Git checkout at ${parent}`);
      }
    }
  }
  const tracked = git(root, ['ls-files', '-z'])
    .stdout.split('\0')
    .filter(Boolean);
  for (const file of tracked) {
    if ([file, ...ancestors(file)].some((parent) => projectPaths.has(parent))) {
      throw new Error(
        `Git tracks ${file}, a path Ultrahome manages. Remove it from the home's index.`,
      );
    }
  }
  // A path held by something else stops only the commands that would clone
  // into it or link there, not the rest of the home.
  const conflicts = new Map();
  for (const [entry, spec] of layout.repos) {
    const checkout = path.join(root, entry);
    if (stat(checkout) && matchingRemote(checkout, spec.remote) === undefined) {
      const recorded = state.repos.get(entry)?.remote;
      conflicts.set(entry, occupied(root, entry, spec.remote, recorded));
    }
  }
  for (const [entry, target] of layout.links) {
    const file = path.join(root, entry);
    if (stat(file) && !matchesLink(file, linkValue(entry, target))) {
      conflicts.set(
        entry,
        `${entry} is occupied. Move it before creating the project link`,
      );
    }
  }
  return {
    conflicts,
    ignore: checkedIgnore(root, projectPaths),
    search: searchIgnore(root, layout.entries),
  };
}

// Loads and checks the home, with `source` in place of its config's text
// when given. `ignore` and `search` are the contents its .gitignore and
// .ignore should have, and `conflicts` maps each project path that something
// else holds to the reason.
export function inspectHome(root, source) {
  const layout = new Layout(root, source);
  const state = readState(root);
  return { layout, state, ...preflight(layout, state) };
}
