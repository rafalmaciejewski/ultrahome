#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { add } from './add.mjs';
import { init } from './init.mjs';
import { findConfig } from './config.mjs';
import { stat } from './filesystem.mjs';
import { remove } from './remove.mjs';
import { printable } from './report.mjs';
import { setup } from './setup.mjs';
import { validate } from './validate.mjs';

// Finds the home, the nearest Git repository with a config at its top, and
// where in it the command runs, as a path from its root.
function findHome() {
  const cwd = realpathSync(process.cwd());
  for (let directory = cwd; ; directory = path.dirname(directory)) {
    if (stat(path.join(directory, '.git')) && findConfig(directory))
      return {
        root: directory,
        cwd,
        here: path.relative(directory, cwd) || '.',
      };
    if (directory === path.dirname(directory)) break;
  }
  throw new Error(
    'No home found: no Git repository above here has a .ultrahome.json. Run npx ultrahome init to create one.',
  );
}

// Turns a project path given from the current directory into one from the
// home root. It resolves `.`, `..`, and absolute paths, so `./team/api`
// works, and a path outside the home stays invalid.
function fromRoot({ root, cwd }, projectPath) {
  const relative = path.relative(root, path.resolve(cwd, projectPath));
  return relative.split(path.sep).join('/') || '.';
}

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const program = new Command('ultrahome')
  .description('Organize Git projects and groups in a shared home repository.')
  .version(version, '-v, --version')
  .helpCommand('help [command]', 'Show help for the CLI or a command')
  .showHelpAfterError();

program
  .command('init')
  .description('Create a home')
  .argument('[dir]', 'Directory for the home', '.')
  .action(async (directory) => {
    process.exitCode = await init(path.resolve(directory));
  });

program
  .command('add')
  .description(
    'Add a project: clone it once at the home root, and link it at <path> when that is in a group',
  )
  .argument(
    '<source>',
    'Git clone URL (HTTP(S) or SSH), or a local path relative to the current directory',
  )
  .argument(
    '<path>',
    'Where the project goes, relative to the current directory: an ID (e.g. api) or a group path (e.g. team/api)',
  )
  .action(async (source, projectPath) => {
    const home = findHome();
    process.exitCode = await add(
      home.root,
      source,
      fromRoot(home, projectPath),
      home.cwd,
    );
  });

program
  .command('remove')
  .alias('rm')
  .description(
    'Remove a group link, or a project (its checkout stays until you delete it)',
  )
  .argument(
    '<path>',
    'Project path relative to the current directory (e.g. team/api)',
  )
  .action(async (projectPath) => {
    const home = findHome();
    process.exitCode = await remove(home.root, fromRoot(home, projectPath));
  });

program
  .command('setup')
  .description(
    'Clone projects, reconcile links, and validate the home (run it from the home root)',
  )
  .action(async () => {
    const { root, here } = findHome();
    // Setup works on the whole home, so a run from a group or a project
    // would change more than the directory it runs in.
    if (here !== '.')
      throw new Error(
        `Run npx ultrahome setup from the home root, ${root}. It sets up the whole home.`,
      );
    process.exitCode = await setup(root);
  });

program
  .command('validate')
  .description(
    'Check the current group (the whole home from its root) and its checkouts',
  )
  .action(() => {
    const { root, here } = findHome();
    process.exitCode = validate(root, here);
  });

try {
  if (process.argv.length === 2) program.outputHelp();
  else await program.parseAsync();
} catch (error) {
  console.error(printable(error.message));
  // Set for a command that a signal stopped.
  process.exitCode = error.exitCode ?? 1;
}
