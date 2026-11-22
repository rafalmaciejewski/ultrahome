import * as fs from 'node:fs';
import path from 'node:path';
import { agentSettingsIssues, checkWorktreeBase } from './agents.mjs';
import { stat } from './filesystem.mjs';
import {
  ignoredPaths,
  inspectHome,
  keptCheckouts,
  keptMessage,
  linkValue,
  matchesLink,
  scopedLayout,
} from './preflight.mjs';
import { checkGuard } from './guard.mjs';
import { exposedPaths } from './ignore.mjs';
import { instructionIssues } from './instructions.mjs';
import { printable, report } from './report.mjs';

export function validationIssues(root, scope = '.') {
  const { layout, state, conflicts, ignore, search } = inspectHome(root);
  const { within, links, repos, groups } = scopedLayout(layout, scope);
  const issues = [];
  for (const [entry, conflict] of conflicts) {
    if (repos.has(entry) || links.has(entry)) issues.push(conflict);
  }
  // The guard protects the whole home, whatever the scope. A warning means
  // setup can't install it, or the user chose a worktree base that bypasses
  // it, so it doesn't fail validation.
  for (const check of [checkGuard(root, state), checkWorktreeBase(root)]) {
    if (check.warning) console.warn(printable(check.warning));
    if (check.issue) issues.push(check.issue);
  }
  const ignoreFile = path.join(root, '.gitignore');
  if (!stat(ignoreFile) || fs.readFileSync(ignoreFile, 'utf8') !== ignore) {
    issues.push('Managed ignore rules are stale. Run npx ultrahome setup.');
  }
  const searchFile = path.join(root, '.ignore');
  if (!stat(searchFile) || fs.readFileSync(searchFile, 'utf8') !== search) {
    issues.push(
      'Managed search rules in .ignore are stale. Run npx ultrahome setup.',
    );
  }
  const instructions = instructionIssues(root, ['.', ...groups]);
  for (const warning of instructions.warnings) console.warn(printable(warning));
  issues.push(...instructions.issues);
  issues.push(...agentSettingsIssues(layout, groups));
  for (const entry of exposedPaths(root, ignoredPaths(layout, state))) {
    if (!within(entry) && !repos.has(entry)) continue;
    issues.push(
      `Git does not ignore ${entry}. Check the ignore rules that apply to this path.`,
    );
  }
  for (const group of groups) {
    if (!stat(path.join(root, group)))
      issues.push(`Missing group ${group}. Run npx ultrahome setup.`);
  }
  for (const entry of repos.keys()) {
    if (conflicts.has(entry)) continue;
    if (!stat(path.join(root, entry))?.isDirectory()) {
      issues.push(
        `Missing checkout ${entry}. Run npx ultrahome setup and verify access to its clone URL.`,
      );
    }
  }
  for (const [entry, target] of links) {
    // Setup can't link to a checkout until its conflict is resolved.
    if (conflicts.has(entry) || conflicts.has(target)) continue;
    if (!matchesLink(path.join(root, entry), linkValue(entry, target))) {
      issues.push(`Missing or stale link ${entry}. Run npx ultrahome setup.`);
    }
  }
  // A dropped checkout that's still there isn't a problem setup can fix.
  const kept = keptCheckouts(layout, state, within);
  for (const entry of kept) console.warn(printable(keptMessage(entry)));
  for (const [recorded, desired] of [
    [state.repos, layout.repos],
    [state.links, layout.links],
  ]) {
    for (const entry of recorded.keys()) {
      if (within(entry) && !desired.has(entry) && !kept.includes(entry))
        issues.push(`Obsolete project path ${entry}. Run npx ultrahome setup.`);
    }
  }
  return issues;
}

export function validate(root, scope = '.') {
  return report('validate', validationIssues(root, scope));
}
