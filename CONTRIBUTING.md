# Contributing to Ultrahome

## Development

```sh
npm ci
npm run format:check
npm test
```

The CLI supports Node.js 22.20 and later, and CI tests it on 22.20, 24 and 26.
semantic-release, a development dependency, needs Node.js 26.13 or later, so
`npm ci` on an older Node prints `EBADENGINE` warnings that you can ignore.

`npm run test:cov` runs the tests with Node's built-in coverage and prints a
report for `src/`. It includes the CLI processes the tests start, since they
inherit Node's coverage settings.

Run `npm run format` to apply Oxfmt across the project.

The tests in `tests/` run the CLI against real Git repositories in temporary
directories. Each `*.test.mjs` file covers one area, and Node runs the files
in parallel. Shared fixtures live in `tests/helpers.mjs`. The search tests
need [ripgrep](https://github.com/BurntSushi/ripgrep) and are skipped without
it, except in CI, where they fail instead.

The lockfile is `npm-shrinkwrap.json` and ships with the package, so `npx`
users get the exact dependency versions tested here. `npm install` updates it
when you change dependencies. A dependency's security fix reaches users only
in a new Ultrahome release.

## Releases

GitHub Actions runs the format check, test suite, and package check on pull
requests to `main` and on pushes to `main`, on Linux and macOS. After a push
passes on every platform and Node version in the matrix, semantic-release
reads the commits since the last `vX.Y.Z` tag, publishes the npm package with
provenance, and creates a GitHub Release with generated notes. It publishes
through npm trusted publishing: npm accepts OIDC tokens from this repository's
`release.yml` workflow, so no npm token is stored anywhere. Provenance needs a
public repository, and publishing from anywhere other than GitHub Actions
fails. The published CLI reports the version assigned at release time.

Use a Conventional Commit message for the commit that lands on `main`. With
squash merges, use the PR title for the commit subject and keep any breaking
change footer in the final commit body.

| Commit example                                                   | Release    |
| ---------------------------------------------------------------- | ---------- |
| `fix: preserve local changes during setup`                       | Patch      |
| `feat: support nested groups`                                    | Minor      |
| A commit with a `BREAKING CHANGE: describe the migration` footer | Major      |
| Only `docs:`, `test:`, or `chore:` commits                       | No release |
