import path from 'node:path';
import { jsonEditor, Layout, parseEntry } from './config.mjs';
import { atomic, stat } from './filesystem.mjs';
import { inspectHome, keptMessage } from './preflight.mjs';
import { disconnectProject } from './setup.mjs';
import { withLock } from './state.mjs';

export function remove(root, projectPath) {
  const { group, project, entry } = parseEntry(projectPath);
  return withLock(root, () => {
    const current = new Layout(root);
    if (!current.entries.has(entry)) {
      throw new Error(
        current.groups.has(entry)
          ? `${entry} is a group. To remove it, delete it from .ultrahome.json and run npx ultrahome setup.`
          : `${entry} is not a project in this home`,
      );
    }
    const users = [...current.links]
      .filter(([, target]) => target === entry)
      .map(([link]) => link);
    if (users.length) {
      throw new Error(
        `Groups link to ${entry}: ${users.join(', ')}. Remove those links first.`,
      );
    }

    const { keys, node } = current.declaration(group);
    // The root keys its projects by ID, and a group lists the IDs it links.
    const key = group === '.' ? project : node.projects.indexOf(project);
    const editor = jsonEditor(current.source);
    editor.remove([...keys, 'projects', key]);
    const updated = editor.toString();
    const home = inspectHome(root, updated);
    atomic(current.file, updated);
    // A link's checkout stays at the home root, which can still use it.
    const target = current.links.get(entry);
    if (target && ![...home.layout.links.values()].includes(target))
      console.log(
        `Kept the checkout at ${target}. To delete it, run npx ultrahome remove ${target} from the home root.`,
      );
    else if (!target && stat(path.join(root, entry)))
      console.log(keptMessage(entry));
    return disconnectProject(home, entry);
  });
}
