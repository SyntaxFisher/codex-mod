# Agent instructions

## Releases and versioning

- Never release without the user's explicit approval. Committing is fine;
  creating or pushing a release tag requires their go-ahead first.
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
  `codex-mod-version.json`; the `Mod` menu displays it. `make patch` installs
  the newest release tag by default; development builds installed with
  `make patch VERSION=head` show the `git describe` suffix next to the
  release.
