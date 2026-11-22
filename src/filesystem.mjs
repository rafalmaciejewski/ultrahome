import * as fs from 'node:fs';
import path from 'node:path';

export function stat(file) {
  return fs.lstatSync(file, { throwIfNoEntry: false });
}

export function temporary(parent, prefix, operation) {
  const dir = fs.mkdtempSync(path.join(parent, prefix));
  try {
    return operation(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function atomic(file, data, mode = stat(file)?.mode ?? 0o644) {
  temporary(path.dirname(file), '.ultrahome-write-', (dir) => {
    const staged = path.join(dir, 'file');
    fs.writeFileSync(staged, data, { mode });
    fs.renameSync(staged, file);
  });
}

// The path of `relative` in the home at `root`. It refuses a symbolic link
// anywhere along the way, which could send a write outside the home.
export function pathInHome(root, relative) {
  let target = root;
  for (const part of path.normalize(relative).split(path.sep)) {
    target = path.join(target, part);
    if (stat(target)?.isSymbolicLink()) {
      throw new Error(
        `Expected a directory or file inside the home, found symlink: ${target}`,
      );
    }
  }
  return target;
}
