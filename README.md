# <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/rafalmaciejewski/ultrahome/main/docs/logo-dark.png"><img src="https://raw.githubusercontent.com/rafalmaciejewski/ultrahome/main/docs/logo.png" alt="Ultrahome" width="380"></picture>

**The Home Repo pattern for multi-repo AI workspaces.**

Keep all your projects and shared agent setup in one home repo. Give each area
of work its own place for your agent sessions.

## Why Ultrahome?

The [Home Repo pattern](https://www.aihero.dev/the-home-repo-pattern) gives your
agent one place to find shared instructions, skills, and links to your projects.
But as the home grows, its project index gets longer and sessions for unrelated
work pile up in the same workspace.

Ultrahome solves this with **groups**: folders that bring related projects
together with their own instructions and skills.

- **Keep agent context focused.** Start your agent in a group and it loads only
  the projects, instructions, and skills that matter for that work.
- **Organize sessions by area of work.** Run checkout sessions from
  `checkout/` and fulfillment sessions from `fulfillment/`. Use the home root
  for work that spans everything.
- **Clone once, use everywhere.** A project shared by several groups is cloned
  once and linked into each of them. Unlike a submodule, it's a plain checkout
  on your own branch, never pinned to a commit.
- **Onboard in one command.** Teammates clone the home and run
  `npx ultrahome setup` to get the same workspace.

## Example

Checkout needs the storefront and payments. Fulfillment needs payments and
shipping. Each project is cloned once and linked into every group that uses it.

```text
team-home/
├── storefront/             # Git checkout
├── payments/               # Git checkout
├── shipping/               # Git checkout
├── checkout/
│   ├── AGENTS.md
│   ├── storefront -> ../storefront
│   └── payments -> ../payments
└── fulfillment/
    ├── AGENTS.md
    ├── payments -> ../payments
    └── shipping -> ../shipping
```

Where you start your agent decides what it sees:

| Start in     | Use it for                               |
| ------------ | ---------------------------------------- |
| `checkout/`  | A feature across storefront and payments |
| `payments/`  | Work in that one project                 |
| `team-home/` | Work across the whole workspace          |

Groups can nest, and each can have its own skills and instructions.

## Getting started

You need macOS or Linux, Git, and Node.js 22.20 or later.

### Join an existing home

Clone the home repo, then run from its root:

```sh
npx ultrahome setup
```

This clones every project and creates the group links. `setup` always works on
the whole home, so it runs only from the root.

### Create a new home

```sh
npx ultrahome init team-home
cd team-home
```

Then add your projects, each with its Git URL and a path in the home:

```sh
npx ultrahome add git@github.com:example/payments.git payments
npx ultrahome add git@github.com:example/storefront.git checkout/storefront
npx ultrahome add git@github.com:example/payments.git checkout/payments
```

Each project is cloned once, at the home root. A path with a group, such as
`checkout/storefront`, also links the project into that group, creating the
group if needed. Adding a repository the home already has only adds the link.

Give each group an `AGENTS.md` that tells agents what the group is for and how
its projects fit together.

To take a link out of a group, or a project out of the home:

```sh
npx ultrahome remove checkout/storefront
npx ultrahome remove storefront
```

Ultrahome never deletes a checkout. After you remove a project, it tells you
how to delete the folder once you've saved anything you need from it.

Commit the home and push it. Its `.gitignore` keeps checkouts, links, and
local settings and state out of Git, so teammates get the same workspace
with `npx ultrahome setup`. You decide whether to commit the Claude Code
settings that `setup` writes for each group. See [What to commit](https://github.com/rafalmaciejewski/ultrahome/blob/main/docs/config.md#what-to-commit).

### Let an agent set it up

Install the [`ultrahome-init` skill](https://github.com/rafalmaciejewski/ultrahome/blob/main/skills/ultrahome-init/SKILL.md):

```sh
npx skills@latest add rafalmaciejewski/ultrahome --skill ultrahome-init -g
```

Then run `ultrahome-init` in your agent and list the repos you want. It can
suggest groups based on how the repos relate. Once you confirm the layout, it
writes the config and `AGENTS.md` files and runs setup.

## Commands

Run each with `npx ultrahome <command>` inside the home. `setup` runs only from
the home root. `validate` checks the whole home from the root, or one group
from that group's directory.

| Command               | What it does                                                 |
| --------------------- | ------------------------------------------------------------ |
| `init [dir]`          | Create a home                                                |
| `add <source> <path>` | Add a project, such as `payments` or `checkout/payments`     |
| `remove <path>`       | Remove a group link, or a project from the home (alias `rm`) |
| `setup`               | Clone projects, create links and agent files, and validate   |
| `validate`            | Check the home without changing anything                     |
| `help [command]`      | Show help for the CLI or a command                           |

See [Commands](https://github.com/rafalmaciejewski/ultrahome/blob/main/docs/commands.md)
for details, and the [config reference](https://github.com/rafalmaciejewski/ultrahome/blob/main/docs/config.md)
for the `.ultrahome.json` format.

## Agents

Start your agent in a group, a project, or the home root.

- **Claude Code** reads each group's instructions and can edit its projects
  once you've trusted the home.
- **Codex** needs the home as an extra writable directory to edit a group's
  projects:

  ```sh
  codex --add-dir "$(git rev-parse --show-toplevel)"
  ```

- **Search** from a group with `rg --follow`, because its projects are
  symbolic links.

See [Working with agents](https://github.com/rafalmaciejewski/ultrahome/blob/main/docs/agents.md)
for how this works.

## Security

Treat a home repo like code that runs on your machine: anyone who can commit
to it decides what teammates clone and what their agents load. Protect its
main branch and review changes to it. See
[Security](https://github.com/rafalmaciejewski/ultrahome/blob/main/docs/security.md)
for how Ultrahome protects your checkouts and how to report a vulnerability.

## License

[MIT](LICENSE)
