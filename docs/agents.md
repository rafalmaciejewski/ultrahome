# Working with agents

`setup` prepares each home so agents such as Claude Code and Codex load its
instructions, can edit its projects, and can search them. How agents do this
can change between versions. This page was last checked with Claude Code
2.1.330 and Codex 0.171.0.

## Instructions

Put instructions for the whole home in its root `AGENTS.md`, and for each
group in the group's own `AGENTS.md`. Agents such as Codex and Claude Code
read the `AGENTS.md` in the directory they start in and in the directories
above it.

To give Claude Code instructions of its own, replace a link with a file that
includes the line `@AGENTS.md`. Claude Code also reads `.claude/CLAUDE.md`,
and `setup` adds no link beside an `AGENTS.md` that has one. It resolves
imports from the file that holds them, so `.claude/CLAUDE.md` needs the line
`@../AGENTS.md`. `validate` warns about a `CLAUDE.md` that neither links to
nor imports its `AGENTS.md`.

## Editing projects from a group

A group's projects are links to checkouts at the home root. Agents let a
session edit files only inside the directory it starts in, and they check the
real path of each file. So without more access, a session started in a group
can read its projects but not edit them.

For Claude Code, `setup` writes a `.claude/settings.json` in each group that
lists the checkouts its links point to as `permissions.additionalDirectories`.
Both Claude Code's file tools and its sandbox then allow edits there, once
you've trusted the home. Ultrahome manages only the entries that point to
checkouts in the home and leaves the rest of the file alone.

The entries are relative to the group, so they work for every teammate, and
the home decides whether to commit these files. Commit them to share them
along with the group's other settings, or add them to `.gitignore` so each
teammate's `setup` writes their own. If the home starts committing them after
you've run `setup`, Git won't pull over your copies: delete them, then pull.
`validate` checks that each group's settings still give access to every
checkout the group links to. An entry you add yourself counts too, such as
one for the whole home, and then `setup` adds nothing for those checkouts.

Ultrahome has no file it can commit to give Codex the same access, so start
Codex in a group with the home as an extra writable directory:

```sh
codex --add-dir "$(git rev-parse --show-toplevel)"
```

## Parallel sessions

Each project has one checkout, and every group that links the project shares
it. So two sessions that change the same project, from one group or from
several, edit the same files on the same branch.

To change a project in parallel, give each session its own worktree of it.
Create the worktree inside the project's checkout, where the group's Claude
Code settings already allow edits, and keep Git from listing it there. From
the home root or a group that links `payments`:

```sh
echo /.worktrees/ >> payments/.git/info/exclude
git -C payments worktree add .worktrees/refunds -b refunds
```

The first line is needed once per checkout. The group's links still point to
the main checkout, so tell the agent to work in `payments/.worktrees/refunds`
and to search it by that path. For a change across several projects, create
a worktree on the same branch in each. Once the branch is pushed, remove the
worktree with `git -C payments worktree remove .worktrees/refunds`.

Don't use Claude Code's own worktrees, such as `claude --worktree`, in the
home. Claude Code creates them from the repository the session starts in,
which in a group is the home. So the session starts at the root of a copy of
the home that has none of its projects. `setup` also stops Claude Code from
fetching the home when it creates one, because that fetch skips Ultrahome's
fetch guard. See [Security](security.md).

## Searching the workspace

Checkouts and links are ignored files in the home, and ripgrep, fd, and agent
search tools built on them skip ignored files. So `setup` keeps a `.ignore`
file at the home root that lets them search the projects again. Git doesn't
read it. Commit it with the home.

From the home root, a search covers every project once. In a group, the
projects are symbolic links, which ripgrep follows only with `--follow` or
when you name the project's path. The `AGENTS.md` that `init` writes tells
agents this.
