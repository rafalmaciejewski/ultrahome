import path from 'node:path';
import {
  ancestors,
  checkRemote,
  cloneRemote,
  isLocalPath,
  jsonEditor,
  Layout,
  parseEntry,
  sameRemote,
} from './config.mjs';
import { atomic } from './filesystem.mjs';
import { inspectHome } from './preflight.mjs';
import { connectProject } from './setup.mjs';
import { withLock } from './state.mjs';

// `add` takes a local path relative to where it runs. Configs store it
// relative to the home root, which is where setup resolves it from.
function configRemote(root, cwd, source) {
  if (!isLocalPath(source) || path.isAbsolute(source)) return source;
  return path
    .relative(root, path.resolve(cwd, source))
    .split(path.sep)
    .join('/');
}

export function add(root, source, projectPath, cwd = root) {
  const { group, project, entry } = parseEntry(projectPath);
  checkRemote(project, source);
  const remote = configRemote(root, cwd, source);
  checkRemote(project, remote);
  const resolved = cloneRemote(root, remote);

  return withLock(root, () => {
    const current = new Layout(root);
    const inside = [group, ...ancestors(group)].find((scope) =>
      current.entries.has(scope),
    );
    if (inside)
      throw new Error(
        `${inside} is a project, not a group. Add projects from the home root or a group directory.`,
      );
    const sameSource = (id) => {
      const spec = current.repos.get(id);
      return spec !== undefined && sameRemote(spec.remote, resolved);
    };
    if (current.entries.has(entry)) {
      if (sameSource(project)) return connectProject(inspectHome(root), entry);
      throw new Error(
        `Project path ${projectPath} already belongs to another source`,
      );
    }

    // Projects are cloned at the home root, and groups link to them under
    // their IDs. A repository the home already has is linked instead of
    // cloned again.
    const existing = [...current.repos.keys()].find(sameSource);
    if (existing !== undefined && existing !== project)
      throw new Error(
        `The home already has this repository as ${existing}. Use that name.`,
      );
    if (existing === undefined && current.repos.has(project))
      throw new Error(
        `The home already has a project ${project} from another source. Choose a different name.`,
      );
    const { keys, node } = current.declaration(group);
    const editor = jsonEditor(current.source);
    if (existing === undefined) editor.set(['projects', project], { remote });
    if (group !== '.') {
      const links = [...keys, 'projects'];
      if (node?.projects === undefined) editor.set(links, [project]);
      else editor.append(links, project);
    }
    const updated = editor.toString();
    const home = inspectHome(root, updated);
    const conflict =
      home.conflicts.get(entry) ??
      home.conflicts.get(home.layout.links.get(entry));
    if (conflict) throw new Error(conflict);
    atomic(current.file, updated);
    return connectProject(home, entry);
  });
}
