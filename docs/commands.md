# Commands

Run each command with `npx ultrahome <command>` inside the home. Commands find
the home by looking up from the current directory for the first Git
repository with a `.ultrahome.json` at its top. `setup` runs only from the
home root. `validate` checks the whole home from the root, or one group from
that group's directory.

## init

```sh
npx ultrahome init [dir]
```

Creates a home in `dir`, the current directory by default: a Git repository
with an empty `.ultrahome.json`, an `AGENTS.md`, a `CLAUDE.md` that links to
it, and the ignore files. Like `setup`, it also installs the fetch guard and
sets the home's local `.claude/settings.local.json`. See [Security](security.md).
Running it again in an existing home keeps its config and `AGENTS.md`.

To start from a layout you already have, write it to `.ultrahome.json` in the
[config format](config.md) and run `setup`.

## add

```sh
npx ultrahome add <source> <path>
```

Adds a project to `.ultrahome.json` and clones it. Every project is cloned
once, at the home root, under its ID.

`<path>` is where the project goes. Its last part is the name, and any parts
before it are groups:

```sh
npx ultrahome add git@github.com:example/payments.git payments
npx ultrahome add git@github.com:example/storefront.git checkout/storefront
```

The first command clones `payments` at the home root. The second clones
`storefront` at the home root and links it into the `checkout` group, which
it creates if needed.

Paths are relative to where you run `add`. From `checkout/`, the same project
is just `storefront`.

When the home already has the repository, `add` links the existing checkout
instead of cloning it again, whatever URL form you give. A link is always
named after its project, so give the project's ID as the name. It's an error
to add a repository the home already has under another name, or another
repository under a name the home already uses.

`<source>` is an HTTP(S) or SSH clone URL, or a local path. A local path is
relative to where you run `add`, and the config stores it relative to the
home root.

If the clone fails, the project stays in the config. Run `add` again, or
`setup`, to retry.

## remove

```sh
npx ultrahome remove <path>
npx ultrahome rm <path>
```

Takes `<path>` out of `.ultrahome.json`. Paths are relative to where you run
it, like `add`.

For a link in a group, `remove` deletes the link and keeps the checkout at the
home root. When no other group links to it, it tells you how to remove that
project too.

For a project at the home root, `remove` takes it out of the config but keeps
its checkout, because Ultrahome never deletes checkouts. The checkout stays
ignored by the home until you delete it, and `remove`, `setup`, and `validate`
tell you how. `remove` refuses a project that groups still link to, so remove
those links first.

`remove` doesn't take out groups, and a group keeps its place in the config
after you remove its last link. To remove a group, delete it from
`.ultrahome.json` and run `setup`. That removes the group's links and
Ultrahome's entries in its Claude Code settings. Then delete what's left of
its directory, such as its `AGENTS.md` and `CLAUDE.md`, and commit the change.

## setup

```sh
npx ultrahome setup
```

Brings the whole home in line with `.ultrahome.json`:

- Clones missing projects and creates the group links.
- Removes the links that the config no longer has. Checkouts it no longer has
  stay where they are, ignored, until you delete them.
- Updates the managed blocks in `.gitignore` and `.ignore`.
- Adds a `CLAUDE.md` link beside each `AGENTS.md`, and writes each group's
  `.claude/settings.json`. See [Working with agents](agents.md).
- Installs the fetch guard, and sets the home's local
  `.claude/settings.local.json` so Claude Code creates worktrees without
  fetching past it. See [Security](security.md).
- Then validates the home.

Run it from the home root after you clone a home, pull changes to its config,
or edit the config by hand. It fails anywhere else, such as in a group or a
project, because changes to one group also affect its parent groups and the
checkouts that other groups share.

A checkout already at a project's path is used as is when any of its remotes
points to the project's repository, over HTTPS or SSH. So a fork setup that
keeps the project as `upstream` works. If something else holds a project's
path, `setup` reports it and sets up the rest of the home.

`setup` clones missing projects, but doesn't pull or update existing ones.

It clones up to six projects at once and shows their progress. Those clones
can't prompt you, so one that needs a password, a key passphrase, or your OK
for a new SSH host fails at first. In a terminal, `setup` then clones it again
on its own, where Git and SSH can ask. If you stop `setup` with Ctrl-C, it
removes partial clones, and the next run clones the rest.

## validate

```sh
npx ultrahome validate
```

Checks the home against its config without changing anything: missing or
stale checkouts, links, ignore rules, agent files, and the fetch guard. Each
issue says how to fix it, usually by running `setup`. It also checks that each
group's Claude Code settings let sessions there edit the group's projects.

From a group directory, it checks only that group, its subgroups, and the
checkouts they link to.

## help

```sh
npx ultrahome help [command]
npx ultrahome <command> --help
npx ultrahome --version
```

`help` shows the commands, or the arguments of one command, as does `--help`
(`-h`). `--version` (`-v`) prints the version of Ultrahome that runs.
