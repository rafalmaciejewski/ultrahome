import * as fs from 'node:fs';
import path from 'node:path';
import { groupsOf, syncAgentSettings, syncWorktreeBase } from './agents.mjs';
import { cloneProjects } from './clone.mjs';
import { META } from './config.mjs';
import { atomic, stat, temporary } from './filesystem.mjs';
import { syncGuard } from './guard.mjs';
import {
  droppedGroups,
  ignoredPaths,
  keptCheckouts,
  linkValue,
  matchesLink,
  inspectHome,
} from './preflight.mjs';
import { saveState, withLock } from './state.mjs';
import { checkedIgnore } from './ignore.mjs';
import { syncInstructions } from './instructions.mjs';
import { report } from './report.mjs';
import { validationIssues } from './validate.mjs';

async function connectProjects(root, repos, state, conflicts, errors) {
  const available = new Set();
  const problems = new Map();
  const missing = [];
  for (const [entry, spec] of repos) {
    if (conflicts.has(entry)) problems.set(entry, conflicts.get(entry));
    else if (!stat(path.join(root, entry))) missing.push([entry, spec]);
    else {
      if (state.repos.get(entry)?.remote !== spec.remote) {
        state.repos.set(entry, { remote: spec.remote });
        saveState(root, state);
      }
      available.add(entry);
    }
  }
  // The fetch guard protects each checkout as soon as it lands, so one that
  // was cloned before an interruption is protected too.
  const failures = await cloneProjects(root, missing, (entry, spec) => {
    state.repos.set(entry, { remote: spec.remote });
    saveState(root, state);
    syncGuard(root, state);
    available.add(entry);
  });
  for (const [entry, message] of failures)
    problems.set(entry, `${entry}: ${message}`);
  for (const entry of repos.keys())
    if (problems.has(entry)) errors.push(problems.get(entry));
  return available;
}

function connectLinks(root, links, state, available, conflicts, errors) {
  for (const [entry, target] of links) {
    if (conflicts.has(entry)) {
      errors.push(conflicts.get(entry));
      continue;
    }
    // A link waits for its checkout.
    if (!available.has(target)) continue;
    const expected = linkValue(entry, target);
    const link = path.join(root, entry);
    if (!matchesLink(link, expected)) {
      temporary(path.join(root, META), '.staging-', (dir) => {
        const staged = path.join(dir, 'link');
        fs.symlinkSync(expected, staged);
        fs.renameSync(staged, link);
      });
    }
    if (state.links.get(entry) !== expected) {
      state.links.set(entry, expected);
      saveState(root, state);
    }
  }
}

function removeObsoleteLinks(root, state, desired, errors, selected) {
  for (const [entry, value] of state.links) {
    if (desired.has(entry) || !selected(entry)) continue;
    const link = path.join(root, entry);
    if (matchesLink(link, value)) {
      fs.unlinkSync(link);
      console.log(`Removed link ${entry}`);
    } else if (stat(link)) {
      errors.push(
        `${entry}: obsolete path was changed locally. Inspect it before removing it`,
      );
      continue;
    }
    state.links.delete(entry);
    saveState(root, state);
  }
}

// Ultrahome never deletes checkouts. It forgets the ones the layout dropped
// once they're gone. Until then they stay ignored and guarded, and validate
// says how to delete them.
function forgetRemovedCheckouts(layout, state, selected) {
  const kept = new Set(keptCheckouts(layout, state, selected));
  for (const entry of state.repos.keys()) {
    if (layout.repos.has(entry)) continue;
    if (!selected(entry) || kept.has(entry)) continue;
    state.repos.delete(entry);
    saveState(layout.root, state);
  }
}

// Removes the directories of dropped groups that nothing is left in. Files
// such as an AGENTS.md keep theirs.
function removeEmptyGroups(root, groups) {
  for (const group of groups) {
    try {
      fs.rmdirSync(path.join(root, group));
      console.log(`Removed group ${group}`);
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes(error.code))
        throw error;
    }
  }
}

function writeIgnores(root, ignore, search) {
  atomic(path.join(root, '.gitignore'), ignore);
  atomic(path.join(root, '.ignore'), search);
}

// Connects the project at `entry`, which the layout just added.
export async function connectProject(
  { layout, state, conflicts, ignore, search },
  entry,
) {
  const { root } = layout;
  writeIgnores(root, ignore, search);
  const target = layout.links.get(entry) ?? entry;
  fs.mkdirSync(path.join(root, path.dirname(entry)), { recursive: true });
  const repos = new Map([[target, layout.repos.get(target)]]);
  const errors = [];
  const available = await connectProjects(
    root,
    repos,
    state,
    conflicts,
    errors,
  );
  if (entry !== target)
    connectLinks(root, [[entry, target]], state, available, conflicts, errors);
  syncAgentSettings(layout, state, groupsOf([entry]));
  syncGuard(root, state);
  return report('add', errors);
}

// Removes the link at `entry`, which the layout no longer has. For a checkout,
// it only stops managing it: Ultrahome never deletes checkouts.
export function disconnectProject({ layout, state, search }, entry) {
  const { root } = layout;
  const errors = [];
  const only = (path) => path === entry;
  // Before removal, while state still lists the checkout as Ultrahome's.
  syncAgentSettings(layout, state, groupsOf([entry]));
  removeObsoleteLinks(root, state, layout.links, errors, only);
  forgetRemovedCheckouts(layout, state, only);
  // A dropped checkout stays ignored until it's deleted.
  writeIgnores(root, checkedIgnore(root, ignoredPaths(layout, state)), search);
  syncGuard(root, state);
  return report('remove', errors);
}

// Brings the whole home in line with its config. It runs only from the home
// root, since parent groups' settings and the shared checkouts depend on
// every group.
async function applySetup({ layout, state, conflicts, ignore, search }) {
  const { root, links, repos, groups } = layout;
  const all = () => true;
  writeIgnores(root, ignore, search);
  for (const group of groups)
    fs.mkdirSync(path.join(root, group), { recursive: true });
  for (const file of syncInstructions(root, groups))
    console.log(`Added ${file} so Claude Code reads AGENTS.md`);
  // Before removals, while state still lists dropped checkouts and groups.
  const dropped = droppedGroups(layout, state);
  syncAgentSettings(layout, state, [...groups, ...dropped]);
  const errors = [];
  removeObsoleteLinks(root, state, links, errors, all);
  const available = await connectProjects(
    root,
    repos,
    state,
    conflicts,
    errors,
  );
  connectLinks(root, links, state, available, conflicts, errors);
  forgetRemovedCheckouts(layout, state, all);
  removeEmptyGroups(root, dropped);
  writeIgnores(root, checkedIgnore(root, ignoredPaths(layout, state)), search);
  syncGuard(root, state);
  syncWorktreeBase(root);
  return report('setup', errors.length ? errors : validationIssues(root));
}

export function setup(root) {
  return withLock(root, () => applySetup(inspectHome(root)));
}
