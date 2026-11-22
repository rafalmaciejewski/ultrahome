import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEdits, modify } from 'jsonc-parser';
import { stat } from './filesystem.mjs';

// Names become file names in the home. They can't start with a dot, which
// would hide them or reach outside (`..`), or with a hyphen, which commands
// read as an option.
const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

// Local state that Git ignores.
export const META = '.ultrahome';
// The home's config, at its root.
export const CONFIG = '.ultrahome.json';
// Files agents read in a group, which a project can't replace.
const RESERVED = new Set(['agents.md', 'claude.md']);

export function isName(value) {
  return (
    typeof value === 'string' &&
    NAME.test(value) &&
    !RESERVED.has(value.toLowerCase())
  );
}

// Returns the config file in `directory`, or undefined if it has none.
export function findConfig(directory) {
  const file = path.join(directory, CONFIG);
  const info = stat(file);
  if (info && !info.isFile())
    throw new Error(`Config must be a regular file inside the home: ${file}`);
  return info && file;
}

export function parseJson(file, source = fs.readFileSync(file, 'utf8')) {
  try {
    const parsed = JSON.parse(source);
    // JSON.parse keeps the last of duplicate keys, so scan for them.
    const stack = [];
    const tokens = source.match(/"(?:\\.|[^"\\])*"|[{}\[\]:]/gs) ?? [];
    for (const [index, token] of tokens.entries()) {
      if (token === '{') stack.push(new Set());
      else if (token === '[') stack.push(null);
      else if (token === '}' || token === ']') stack.pop();
      else if (token.startsWith('"') && tokens[index + 1] === ':') {
        const key = JSON.parse(token);
        const keys = stack.at(-1);
        if (keys.has(key))
          throw new Error(`Duplicate JSON key ${JSON.stringify(key)}`);
        keys.add(key);
      }
    }
    return parsed;
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
}

// Edits JSON text in place, keeping its formatting. Missing parent objects
// are created.
export function jsonEditor(source) {
  let text = source;
  const formattingOptions = {
    insertSpaces: true,
    tabSize: 2,
    eol: source.includes('\r\n') ? '\r\n' : '\n',
  };
  const set = (keys, value) => {
    text = applyEdits(text, modify(text, keys, value, { formattingOptions }));
  };
  return {
    set,
    append: (keys, value) => set([...keys, -1], value),
    // jsonc-parser removes a property or array item set to undefined.
    remove: (keys) => set(keys, undefined),
    toString: () => text,
  };
}

export function entries(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return Object.entries(value);
}

export function fields(value, allowed, label) {
  for (const [key] of entries(value, label)) {
    if (!allowed.includes(key))
      throw new Error(`${label}: unexpected field "${key}"`);
  }
}

function optional(object, key, fallback) {
  return Object.hasOwn(object, key) ? object[key] : fallback;
}

// Splits a project path such as team/api into its group and project ID. A
// trailing slash, as shells add when completing a directory, is allowed.
export function parseEntry(projectPath) {
  const parts = projectPath.replace(/\/+$/, '').split('/');
  if (!parts.every(isName))
    throw new Error(`Invalid project path: ${projectPath}`);
  const project = parts.pop();
  const group = path.join('.', ...parts);
  return { group, project, entry: path.join(group, project) };
}

function name(value) {
  if (!isName(value)) {
    throw new Error(
      typeof value === 'string' && RESERVED.has(value.toLowerCase())
        ? `Invalid name ${JSON.stringify(value)}. Ultrahome and agents use that file name`
        : `Invalid name ${JSON.stringify(value)}. Use letters, digits, dots, hyphens or underscores, and don't start with a dot or hyphen`,
    );
  }
  return value;
}

// URL schemes Git clones over HTTP(S), SSH, or the local filesystem. Cloning
// also enforces this (TRANSPORTS in git.mjs); checking here reports it
// before anything is written.
const SCHEMES = ['file', 'git+ssh', 'http', 'https', 'ssh', 'ssh+git'];

function checkTransport(key, remote) {
  const [, scheme, separator] =
    /^([a-z][a-z\d+.-]*)(::|:\/\/)/i.exec(remote) ?? [];
  if (
    separator === '::' ||
    (scheme && !SCHEMES.includes(scheme.toLowerCase()))
  ) {
    throw new Error(
      `Project ${key}: use an HTTP(S) or SSH URL, or a local path, as its remote`,
    );
  }
  const url = scheme && URL.parse(remote);
  // A user name is normal for SSH (git@host), but over HTTP(S) it's
  // usually a token.
  if (url && (url.password || (/^https?:$/.test(url.protocol) && url.username)))
    throw new Error(
      `Project ${key}: remove credentials from the URL. Use a Git credential helper or SSH keys.`,
    );
}

// Checks a project's remote the same way for configs and `add`.
export function checkRemote(key, remote) {
  if (
    typeof remote !== 'string' ||
    !remote.trim() ||
    remote.startsWith('-') ||
    remote.includes('\0')
  )
    throw new Error(`Project ${key} requires a Git clone URL`);
  checkTransport(key, remote);
}

// Git treats a colon before the first slash as a URL or an scp-style SSH
// address. Anything else is a local path.
export function isLocalPath(remote) {
  return path.isAbsolute(remote) || !/^[^/]+:/.test(remote);
}

// Git records an absolute origin when cloning a local path, so relative paths
// resolve from the home root.
export function cloneRemote(root, remote) {
  if (!isLocalPath(remote) || path.isAbsolute(remote)) return remote;
  return path.resolve(root, remote);
}

// What identifies the repository a clone URL points to. Forges such as
// GitHub serve a repository over HTTPS and SSH, with or without `.git`, and
// in any letter case, so those forms compare equal. Local paths keep their
// case.
function remoteIdentity(remote) {
  const trim = (text) => text.replace(/\/+$/, '');
  const local = (file) => path.resolve(file).replace(/\/\.git$/, '');
  if (isLocalPath(remote)) return local(remote);
  let host = '';
  let pathname = '';
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(remote)) {
    const url = URL.parse(remote);
    if (!url) return remote;
    if (url.protocol === 'file:') {
      try {
        return local(fileURLToPath(url));
      } catch {
        return remote;
      }
    }
    host = url.hostname;
    pathname = url.pathname;
  } else {
    // scp-style SSH, such as git@github.com:org/repo.git
    const scp = /^(?:[^@/]*@)?([^:/]+):(.*)$/.exec(remote);
    if (!scp) return remote;
    [, host, pathname] = scp;
  }
  // `host:repo`, `ssh://host/repo`, and `ssh://host/~/repo` all name the
  // same repository on a forge.
  pathname = trim(
    trim(pathname.replace(/^\/*(?:~\/)?/, '')).replace(/\.git$/i, ''),
  );
  return `//${host}/${pathname}`.toLowerCase();
}

export function sameRemote(a, b) {
  return remoteIdentity(a) === remoteIdentity(b);
}

export function ancestors(scope) {
  const parents = [];
  while (scope !== '.') {
    scope = path.dirname(scope);
    parents.push(scope);
  }
  return parents;
}

export class Layout {
  // `source` checks new config text before it's written. `file` and `source`
  // are the config's path and text, which add and remove edit.
  constructor(root, source) {
    const file = path.join(root, CONFIG);
    this.root = root;
    if (source === undefined) {
      if (!findConfig(root)) throw new Error(`Missing ${file}`);
      source = fs.readFileSync(file, 'utf8');
    }
    this.file = file;
    this.source = source;
    this.groups = new Set(['.']);
    this.repos = new Map();
    this.links = new Map();
    this.entries = new Set();
    this.folded = new Map();
    // parseJson already names the file in its errors.
    this.config = parseJson(file, source);
    try {
      this.load(this.config);
    } catch (error) {
      throw new Error(`${path.relative(root, file)}: ${error.message}`);
    }
    for (const group of this.groups) {
      if (this.entries.has(group))
        throw new Error(`${group} is both a group and a project`);
    }
  }

  // The keys that lead to `group` in the config, and the group's object
  // there, or undefined if the config doesn't declare it yet.
  declaration(group) {
    const keys = [];
    let node = this.config;
    for (const name of group === '.' ? [] : group.split(path.sep)) {
      keys.push('groups', name);
      node = node?.groups?.[name];
    }
    return { keys, node };
  }

  // Case-insensitive filesystems, such as macOS's default, treat Api and api
  // as one path, so paths in the home must differ by more than case.
  claim(file) {
    const other = this.folded.get(file.toLowerCase());
    if (other !== undefined && other !== file)
      throw new Error(`${other} and ${file} differ only in letter case`);
    this.folded.set(file.toLowerCase(), file);
  }

  // A project's checkout at the root, or a link to it in a group, named
  // after its ID either way.
  addEntry(scope, id) {
    const entry = path.join(scope, id);
    this.claim(entry);
    this.entries.add(entry);
    if (entry !== id) this.links.set(entry, id);
  }

  load(config) {
    fields(config, ['version', 'projects', 'groups'], 'config');
    if (config.version !== 1) throw new Error('Config version must be 1');
    for (const [key, spec] of entries(
      optional(config, 'projects', {}),
      'projects',
    ))
      this.register(key, spec);
    this.addGroups('.', optional(config, 'groups', {}));
  }

  // Every project is cloned at the home root, at its ID.
  register(key, spec) {
    name(key);
    fields(spec, ['remote', 'baseBranch'], `project ${key}`);
    checkRemote(key, spec.remote);
    const branch = spec.baseBranch;
    if (
      Object.hasOwn(spec, 'baseBranch') &&
      (typeof branch !== 'string' ||
        !branch.trim() ||
        branch.startsWith('-') ||
        branch.includes('\0'))
    ) {
      throw new Error(`Project ${key} has an invalid baseBranch`);
    }
    this.repos.set(key, {
      ...spec,
      remote: cloneRemote(this.root, spec.remote),
    });
    this.addEntry('.', key);
  }

  // A group links projects, listed by their IDs.
  addGroups(parent, groups) {
    for (const [key, spec] of entries(groups, 'groups')) {
      const group = path.join(parent, name(key));
      this.claim(group);
      this.groups.add(group);
      fields(spec, ['projects', 'groups'], `group ${group}`);
      const projects = optional(spec, 'projects', []);
      if (
        !Array.isArray(projects) ||
        projects.length !== new Set(projects).size
      )
        throw new Error(
          `group ${group} projects must be a list of unique project IDs`,
        );
      for (const id of projects) {
        if (!this.repos.has(name(id)))
          throw new Error(
            `${path.join(group, id)} refers to unknown project ${JSON.stringify(id)}`,
          );
        this.addEntry(group, id);
      }
      this.addGroups(group, optional(spec, 'groups', {}));
    }
  }
}
