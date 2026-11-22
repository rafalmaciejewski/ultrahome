import * as fs from 'node:fs';
import path from 'node:path';
import { LOCAL_SETTINGS, syncWorktreeBase } from './agents.mjs';
import { CONFIG } from './config.mjs';
import { atomic, pathInHome, stat } from './filesystem.mjs';
import { git } from './git.mjs';
import { syncGuard } from './guard.mjs';
import { checkedIgnore, searchIgnore } from './ignore.mjs';
import { syncInstructions } from './instructions.mjs';
import { readState, withLock } from './state.mjs';

const emptyConfig =
  JSON.stringify({ version: 1, projects: {}, groups: {} }, null, 2) + '\n';
const instructions = `# Home repo

This repo collects Git projects and organizes them into groups. A group is a
directory of links to the projects that one area of work needs.

- For work in one area, open its group and read the group's AGENTS.md first.
- Each project is its own Git repository. Run Git commands inside the
  project, not from this repo, and follow the project's own instructions there.
- A group's projects are symbolic links. If a search from a group finds
  nothing, follow links (\`rg --follow\`) or search the project's path.
- Run \`npx ultrahome setup\` from this repo's root to connect projects and
  validate the home.
`;

export function init(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const root = fs.realpathSync(directory);

  return withLock(root, () => {
    const config = pathInHome(root, CONFIG);
    const agents = pathInHome(root, 'AGENTS.md');
    const ignore = pathInHome(root, '.gitignore');
    const search = pathInHome(root, '.ignore');
    for (const file of [config, agents, ignore, search]) {
      const info = stat(file);
      if (info && !info.isFile())
        throw new Error(`Expected a regular file at ${file}`);
    }
    if (!stat(path.join(root, '.git'))) git(root, ['init', '--quiet']);
    const topLevel = git(root, [
      'rev-parse',
      '--show-toplevel',
    ]).stdout.trimEnd();
    if (fs.realpathSync(topLevel) !== root)
      throw new Error(`Expected a Git repository at ${root}`);

    // Running it again in a home keeps its config and its ignore files.
    if (!stat(config) || !stat(ignore))
      atomic(ignore, checkedIgnore(root, [LOCAL_SETTINGS]));
    if (!stat(config) || !stat(search)) atomic(search, searchIgnore(root));
    if (!stat(agents)) fs.writeFileSync(agents, instructions, { flag: 'wx' });
    syncInstructions(root, ['.']);
    if (!stat(config)) atomic(config, emptyConfig);
    syncGuard(root, readState(root));
    syncWorktreeBase(root);
    console.log(
      `Initialized a home at ${root}. Add projects with npx ultrahome add <source> <path>.`,
    );
    return 0;
  });
}
