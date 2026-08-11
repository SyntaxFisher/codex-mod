# Agent instructions

## Releases and versioning

- A release is a semver Git tag on `main` without a `v` prefix, for example `1.0.0`.
- The updater (the LaunchAgent and the in-app `Codex Mod` menu) only pulls and
  re-patches when a release tag newer than the installed one appears on the
  remote. Commits pushed without a new tag are never installed automatically.
- Always tag actual releases. To release: commit on `main`, then

  ```sh
  git tag -a <version> -m "<one-line summary>"
  git push --follow-tags
  ```

- Never delete or move a published release tag.
- The patcher bakes the installed release into the application as
  `codex-mod-version.json`; the `Codex Mod` menu displays it. Development
  builds installed with `make patch` show the `git describe` suffix next to
  the release.
