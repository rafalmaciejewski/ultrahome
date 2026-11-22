import * as fs from 'node:fs';
import path from 'node:path';
import { parse, printParseErrorCode } from 'jsonc-parser';
import { ancestors, jsonEditor } from './config.mjs';
import { atomic, pathInHome, stat } from './filesystem.mjs';

// Claude Code reads .claude/settings.json from the directory it starts in,
// and edits files only inside its working directories. Its file tools and
// its sandbox both check the real path, so a session started in a group
// can't edit the checkouts that the group's links point to. Each group's
// settings list those checkouts as additional working directories, relative
// to the group, so they're the same for every teammate. Ultrahome doesn't
// ignore them: the home can commit them, or ignore them and leave them to
// each teammate's setup.
const SETTINGS = path.join('.claude', 'settings.json');
const KEYS = ['permissions', 'additionalDirectories'];

// The Claude Code settings file of each group in `groups`.
function settingsFiles(groups) {
  return [...groups]
    .filter((group) => group !== '.')
    .map((group) => path.join(group, SETTINGS));
}

// The checkouts that links in `group` or its subgroups point to.
function linkedCheckouts(layout, group) {
  const targets = [...layout.links]
    .filter(([entry]) => entry.startsWith(group + path.sep))
    .map(([, target]) => target);
  return [...new Set(targets)].sort();
}

// Whether the additional directory `value`, from the settings of `group`,
// gives access to the checkout `target`: it names the checkout or a
// directory above it, such as the home.
function covers(root, group, value, target) {
  if (typeof value !== 'string') return false;
  const inside = path.relative(
    path.resolve(root, group, value),
    path.join(root, target),
  );
  return !path.isAbsolute(inside) && inside.split(path.sep)[0] !== '..';
}

function read(root, file) {
  if (!stat(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  const errors = [];
  const settings = parse(text, errors);
  const label = path.relative(root, file);
  if (errors.length)
    throw new Error(`${label}: ${printParseErrorCode(errors[0].error)}`);
  const object = (value) =>
    value && typeof value === 'object' && !Array.isArray(value);
  if (!object(settings)) throw new Error(`${label} must hold a JSON object`);
  if (settings.permissions !== undefined && !object(settings.permissions))
    throw new Error(`${label}: permissions must be an object`);
  const directories = settings.permissions?.additionalDirectories ?? [];
  if (!Array.isArray(directories))
    throw new Error(
      `${label}: permissions.additionalDirectories must be a list`,
    );
  return { text, settings, directories };
}

// The settings file of `group`, and whether it's stale. `text` is what it
// should hold, or undefined if it should be deleted.
function plan(layout, state, group) {
  const { root } = layout;
  const file = pathInHome(root, path.join(group, SETTINGS));
  const { text, settings, directories = [] } = read(root, file);
  // Entries for checkouts in the home are Ultrahome's. Others are the user's.
  // It keeps one entry for each checkout the group links to.
  const managed = new Set([...layout.repos.keys(), ...state.repos.keys()]);
  const needed = linkedCheckouts(layout, group);
  const seen = new Set();
  const kept = directories.filter((value) => {
    if (typeof value !== 'string') return true;
    const target = path.relative(root, path.resolve(root, group, value));
    if (!managed.has(target)) return true;
    if (!needed.includes(target) || seen.has(target)) return false;
    seen.add(target);
    return true;
  });
  // An entry of the user's, such as one for the whole home, can already
  // cover a checkout.
  const added = needed
    .filter(
      (target) => !kept.some((value) => covers(root, group, value, target)),
    )
    .map((target) => path.relative(group, target).split(path.sep).join('/'));
  const next = [...kept, ...added];
  if (
    next.length === directories.length &&
    next.every((value, index) => value === directories[index])
  )
    return { file, stale: false };
  if (text === undefined) {
    const created = { permissions: { additionalDirectories: next } };
    return { file, stale: true, text: JSON.stringify(created, null, 2) + '\n' };
  }
  const editor = jsonEditor(text);
  if (next.length) editor.set(KEYS, next);
  else if (Object.keys(settings.permissions).length > 1) editor.remove(KEYS);
  else if (Object.keys(settings).length > 1) editor.remove(['permissions']);
  else return { file, stale: true };
  return { file, stale: true, text: editor.toString() };
}

// Brings the Claude Code settings of each group in `groups` in line with
// its links.
export function syncAgentSettings(layout, state, groups) {
  for (const group of new Set(groups)) {
    if (group === '.') continue;
    const { file, stale, text } = plan(layout, state, group);
    if (!stale) continue;
    const label = path.join(group, SETTINGS);
    if (text === undefined) {
      fs.unlinkSync(file);
      try {
        fs.rmdirSync(path.dirname(file));
      } catch (error) {
        if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error;
      }
      console.log(`Removed ${label}, since ${group} links no projects`);
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      atomic(file, text);
      console.log(
        `Updated ${label} so Claude Code can edit the group's projects`,
      );
    }
  }
}

// Claude Code creates worktrees for `claude --worktree` and for subagents.
// By default it first fetches the home's default branch, and it runs its Git
// commands without hooks, so the fetch guard never sees that fetch, and the
// next pull checks out what it brought. A worktree based on the local HEAD
// needs no fetch. Claude Code reads local settings at the repository's main
// root, for sessions started in groups and in worktrees too. They're each
// teammate's own, so the home's .gitignore lists them and the fetch guard
// protects them.
export const LOCAL_SETTINGS = path.join('.claude', 'settings.local.json');
const BASE = ['worktree', 'baseRef'];

// The home's local Claude Code settings, and the worktree base they set.
function worktreeBase(root) {
  const file = pathInHome(root, LOCAL_SETTINGS);
  const { text, settings } = read(root, file);
  const worktree = settings?.worktree;
  if (
    worktree !== undefined &&
    (!worktree || typeof worktree !== 'object' || Array.isArray(worktree))
  )
    throw new Error(`${LOCAL_SETTINGS}: worktree must be an object`);
  return { file, text, value: worktree?.baseRef };
}

// Makes Claude Code base new worktrees of the home on its local HEAD, unless
// the user chose a base.
export function syncWorktreeBase(root) {
  const { file, text, value } = worktreeBase(root);
  if (value !== undefined) return;
  let updated;
  if (text === undefined) {
    updated = JSON.stringify({ worktree: { baseRef: 'head' } }, null, 2) + '\n';
  } else {
    const editor = jsonEditor(text);
    editor.set(BASE, 'head');
    updated = editor.toString();
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomic(file, updated);
  console.log(
    `Updated ${LOCAL_SETTINGS} so Claude Code creates worktrees without fetching`,
  );
}

// An issue setup can fix, or a warning about a base the user chose.
export function checkWorktreeBase(root) {
  const { value } = worktreeBase(root);
  if (value === undefined)
    return {
      issue: `${LOCAL_SETTINGS} doesn't set worktree.baseRef, so Claude Code fetches the home without the fetch guard when it creates a worktree. Run npx ultrahome setup.`,
    };
  if (value !== 'head')
    return {
      warning: `${LOCAL_SETTINGS} sets worktree.baseRef to ${JSON.stringify(value)}, so Claude Code fetches the home without the fetch guard when it creates a worktree. See https://github.com/rafalmaciejewski/ultrahome/blob/main/docs/security.md`,
    };
  return {};
}

// The groups whose settings can change when `entries` are added or removed.
export function groupsOf(entries) {
  return entries.flatMap((entry) => ancestors(entry));
}

// Checks that each group's settings let Claude Code sessions there edit the
// checkouts it links to, whoever wrote the entries that do.
export function agentSettingsIssues(layout, groups) {
  const { root } = layout;
  const issues = [];
  for (const file of settingsFiles(groups)) {
    const group = path.dirname(path.dirname(file));
    const { directories = [] } = read(root, pathInHome(root, file));
    const missing = linkedCheckouts(layout, group).filter(
      (target) =>
        !directories.some((value) => covers(root, group, value, target)),
    );
    if (missing.length)
      issues.push(
        `${file} doesn't give Claude Code access to ${missing.join(', ')} in permissions.additionalDirectories, so sessions in ${group} can't edit them. Run npx ultrahome setup.`,
      );
  }
  return issues;
}
