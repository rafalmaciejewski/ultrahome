# Security

Treat a home repo like code that runs on your machine. Anyone who can commit
to it decides what teammates clone and which instructions and settings their
agents load. Protect its main branch and review changes to `.ultrahome.json`
and agent files.

Ultrahome limits what a home commit can do:

- **Clone sources.** Projects clone only over HTTP(S), SSH, or from a local
  path. Ultrahome rejects other Git transports, such as remote helpers, and
  credentials in URLs.
- **Local state.** Ultrahome refuses to run while Git tracks its `.ultrahome/`
  directory, because its contents would come from whoever made the commit.
- **Fetch guard.** Checkouts are ignored files in the home, and Git deletes or
  overwrites ignored files when it checks out a commit that tracks their paths.
  So a home commit that tracks a checkout's path would destroy that checkout,
  unpushed work included, on your next `git pull`. `setup` installs a
  `reference-transaction` hook that refuses to fetch such commits. It also
  refuses commits that track the home's `.claude/settings.local.json`, which
  holds your own Claude Code permissions and the worktree base described
  below. If Git reports that Ultrahome refused a ref update, push or copy
  anything you need from the named path and move it out of the home before
  you fetch again.

  Git fetches every branch together, so one branch on the remote that tracks
  a checkout's path stops `git fetch` and `git pull` for everyone, even on
  other branches. This can happen when a pull request turns a project into a
  group, for example. The message names the branch and the command that pulls
  only your current branch, such as `git pull origin main`. Remove the path
  from that branch, or delete the branch, to fetch normally again.

The fetch guard has gaps:

- It doesn't check `git pull <url>`, which updates no remote-tracking branch.
  Pull from a configured remote instead.
- Git skips it when `core.hooksPath` is set or another `reference-transaction`
  hook is installed. `validate` warns when that happens.
- Commits fetched before it was installed aren't checked. Run `setup` after
  upgrading Ultrahome.
- Claude Code runs its Git commands without hooks. When it creates a worktree
  of the home, for `claude --worktree` or a subagent, it can fetch the home's
  default branch first, and the next `git pull` would then overwrite a
  checkout before the guard refuses the update. So `setup` sets
  `worktree.baseRef` to `"head"` in the home's local
  `.claude/settings.local.json`, which makes Claude Code start worktrees from
  your local branch without fetching. `validate` warns if you set another
  base there.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: on the repository's Security
tab, choose
[Report a vulnerability](https://github.com/rafalmaciejewski/ultrahome/security/advisories/new).
Don't open a public issue for one, because that tells everyone about it before
a fix is out. Use [issues](https://github.com/rafalmaciejewski/ultrahome/issues)
for other bugs.
