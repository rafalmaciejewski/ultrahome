# Config reference

Ultrahome reads your home's layout from `.ultrahome.json` at its root. It's
the home's only config: it registers every project and declares every group.

You rarely need to write it by hand, because `ultrahome add` and
`ultrahome remove` update it for you, keeping its formatting and key order.
When you do edit it, run `ultrahome setup` to apply the changes, or
`ultrahome validate` to check them.

## Example

This config creates the workspace shown in the [README](../README.md):

```json
{
  "version": 1,
  "projects": {
    "storefront": { "remote": "git@github.com:example/storefront.git" },
    "payments": { "remote": "git@github.com:example/payments.git" },
    "shipping": { "remote": "git@github.com:example/shipping.git" }
  },
  "groups": {
    "checkout": { "projects": ["storefront", "payments"] },
    "fulfillment": { "projects": ["payments", "shipping"] }
  }
}
```

```text
team-home/
├── storefront/             # Git checkout
├── payments/               # Git checkout
├── shipping/               # Git checkout
├── checkout/
│   ├── storefront -> ../storefront
│   └── payments -> ../payments
└── fulfillment/
    ├── payments -> ../payments
    └── shipping -> ../shipping
```

## Fields

**Config**

| Field      | Required | Description                                            |
| ---------- | -------- | ------------------------------------------------------ |
| `version`  | Yes      | Always `1`.                                            |
| `projects` | No       | Projects cloned at the home root, keyed by project ID. |
| `groups`   | No       | Groups at the home root, keyed by group name.          |

**Project object**

| Field        | Required | Description                                                               |
| ------------ | -------- | ------------------------------------------------------------------------- |
| `remote`     | Yes      | Git clone URL: HTTP(S), SSH, or a local path relative to the home root.   |
| `baseBranch` | No       | Branch to check out on the first clone. Defaults to the remote's default. |

**Group**

| Field      | Required | Description                                 |
| ---------- | -------- | ------------------------------------------- |
| `projects` | No       | IDs of the projects to link into the group. |
| `groups`   | No       | Subgroups, in the same format.              |

Ultrahome rejects unknown fields and duplicate keys.

## Projects

Each entry in the config's `projects` is a project object, which registers a
Git repo under that ID and clones it at `<home>/<id>`. Groups link to that
checkout instead of cloning it again, so each project has a single checkout.

A checkout at a project's path counts as that project when any of its Git
remotes points to the project's repository. Ultrahome compares the host and
path, ignoring the protocol, port, user name, a trailing `.git`, and letter
case, so `https://github.com/example/payments.git` and
`git@github.com:example/payments` match. A fork setup that keeps the project
as `upstream` works too.

If a project's `remote` changes to another repository, checkouts with the old
URL no longer match. `setup` and `validate` report each one with the
`git remote set-url` command that updates it, and `setup` still sets up the
rest of the home.

Ultrahome rejects other Git transports, such as `<helper>::<address>` remote
helpers, because they can run programs installed on a teammate's machine.

Don't put credentials in clone URLs. Ultrahome rejects HTTP(S) URLs with a
user name or password, and any URL with a password, so use SSH keys or a Git
credential helper instead.

## Groups

A group is a directory of links to projects in the config's `projects`.
Groups never hold checkouts of their own. Their `projects` field lists the
IDs of the projects to link, and each link is named after its project:

```json
"checkout": { "projects": ["storefront", "payments"] }
```

Nest groups with `groups`, using the same format at every level. Any group
can link any project.

To remove a group, delete it here and run `ultrahome setup`. See
[remove](commands.md#remove).

## Names

Project IDs and group names use letters, digits, dots, hyphens, and
underscores, and can't start with a dot or hyphen. So a project can keep
its repository's name, such as `Next.js`. A name can't be `AGENTS.md` or
`CLAUDE.md`.

Projects and groups in the same directory need distinct names, and
names that differ only in letter case count as the same. Case-insensitive
filesystems, such as macOS's default, treat `Api` and `api` as one path.

## What to commit

`setup` keeps a managed block in `.gitignore` that covers checkouts, links,
the home's `.claude/settings.local.json`, and the `.ultrahome/` directory,
which holds local state. It keeps a matching block in `.ignore` so search
tools such as ripgrep still see the projects. Lines outside the managed
blocks are yours.

Commit `.ultrahome.json`, both ignore files, and the `AGENTS.md` files with the
`CLAUDE.md` links that `setup` adds beside them. Anyone who clones the home
then gets the same workspace by running `npx ultrahome setup`.

`setup` also writes each group's `.claude/settings.json` for Claude Code. See
[Working with agents](agents.md). Ultrahome doesn't ignore these, so you
decide: commit them to share them, or list them in `.gitignore`, outside the
managed block, so each teammate's `setup` writes their own.

Never commit `.ultrahome/`. Ultrahome refuses to run while Git tracks it,
because its contents would come from whoever made the commit.
