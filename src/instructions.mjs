import * as fs from 'node:fs';
import path from 'node:path';
import { pathInHome, stat } from './filesystem.mjs';

// Claude Code reads AGENTS.md only while no CLAUDE.md exists in the working
// directory or above it, and some sessions read CLAUDE.md only. So one
// CLAUDE.md anywhere up the tree would hide every group's AGENTS.md. A
// CLAUDE.md beside each AGENTS.md that links to it loads it in every case.
// A CLAUDE.md that imports it works too.
const CLAUDE_FILES = ['CLAUDE.md', path.join('.claude', 'CLAUDE.md')];

// The path that imports `agents` into the CLAUDE.md at `file`. Claude Code
// resolves an import from the file that holds it, so .claude/CLAUDE.md
// imports ../AGENTS.md.
function importPath(file, agents) {
  return path.relative(path.dirname(file), agents).split(path.sep).join('/');
}

function loadsAgents(file, agents) {
  try {
    if (fs.realpathSync(file) === fs.realpathSync(agents)) return true;
    const target = importPath(file, agents).replaceAll('.', '\\.');
    return new RegExp(`(?:^|\\s)@(?:\\./)?${target}(?=\\s|$)`).test(
      fs.readFileSync(file, 'utf8'),
    );
  } catch {
    return false;
  }
}

// How `dir` loads its AGENTS.md: `missing` names the CLAUDE.md to add, and
// `unlinked` names a CLAUDE.md that neither links to nor imports it.
function inspect(root, dir) {
  const agents = path.join(root, dir, 'AGENTS.md');
  if (!stat(agents)?.isFile()) return {};
  const existing = CLAUDE_FILES.map((name) => path.join(dir, name)).filter(
    (file) => stat(path.join(root, file)),
  );
  if (!existing.length) return { missing: path.join(dir, 'CLAUDE.md') };
  if (existing.some((file) => loadsAgents(path.join(root, file), agents)))
    return {};
  return { unlinked: existing[0] };
}

// Links each missing CLAUDE.md to its AGENTS.md and returns their paths.
export function syncInstructions(root, dirs) {
  const added = [];
  for (const dir of new Set(dirs)) {
    const { missing } = inspect(root, dir);
    if (!missing) continue;
    fs.symlinkSync('AGENTS.md', pathInHome(root, missing));
    added.push(missing);
  }
  return added;
}

export function instructionIssues(root, dirs) {
  const issues = [];
  const warnings = [];
  for (const dir of new Set(dirs)) {
    const { missing, unlinked } = inspect(root, dir);
    const agents = path.join(dir, 'AGENTS.md');
    if (missing)
      issues.push(
        `Missing ${missing}, so some Claude Code sessions skip ${agents}. Run npx ultrahome setup.`,
      );
    if (unlinked)
      warnings.push(
        `${unlinked} doesn't link to or import AGENTS.md, so Claude Code skips ${agents} by default. Add a line with @${importPath(unlinked, agents)} to it.`,
      );
  }
  return { issues, warnings };
}
