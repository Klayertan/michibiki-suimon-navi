# CLAUDE.md

Project-specific instructions for Claude Code when working in this repository.

## Git workflow

After completing any task that modifies repository files:

1. Review `git status` and `git diff`.
2. Run the relevant tests, linting, type checks, or build validation for the files changed.
3. If validation succeeds, automatically create a Git commit without waiting for the user to ask.
4. Commit only files related to the current task.
5. Never include unrelated pre-existing changes.
6. Use a concise, descriptive Conventional Commit message, such as:
   - `feat: ...`
   - `fix: ...`
   - `refactor: ...`
   - `docs: ...`
   - `test: ...`
   - `chore: ...`
7. After committing, report the commit SHA and commit message.
8. Never push to GitHub unless the user explicitly asks to push.
9. Never force-push.
10. If tests fail, fix the failure first. Do not commit known-broken code unless the user explicitly requests a WIP commit.
11. If the repository was already dirty before the task, preserve unrelated pre-existing changes and do not stage them.
12. If the task only involves investigation, explanation, or reading files and nothing was changed, do not create an empty commit.
