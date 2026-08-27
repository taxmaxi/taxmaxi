---
name: squash-migrations
description: Squash all Drizzle migrations introduced by the current TaxMaxi branch or PR into one migration.sql and snapshot.json pair. Use before merging a branch with several new migrations; do not rewrite migrations already present on main.
---

# Squash Branch Migrations

Leave the branch with one new directory under `packages/persistence/drizzle/`, containing one `migration.sql` and one `snapshot.json`. Keep every migration on local `main` unchanged.

## Guardrails

- Run from the repository root. Use `mise x -- pnpm ...` for package scripts.
- Use local `main` as the base unless the user names another base. Do not pull or rewrite `main` as part of this workflow.
- Record the current branch with `git branch --show-current`. Stop on `main` or a detached `HEAD`.
- Inspect `git status --short`. Do not stash, discard, or overwrite unrelated work. If it prevents switching branches, stop and explain what must be resolved.
- Do not commit or push unless the user asks.

## Find the Branch Migrations

1. List files added relative to the base, including untracked files:

   ```bash
   git diff --name-only --diff-filter=A main -- packages/persistence/drizzle
   git ls-files --others --exclude-standard packages/persistence/drizzle
   ```

2. Reduce the results to migration directories. A branch migration directory normally contains only `migration.sql` and `snapshot.json`.
3. Confirm every proposed directory is absent from `main` with `git ls-tree`. Never select a directory only because its timestamp looks recent, and never remove a directory present on `main`.
4. Inspect every selected `migration.sql` before deletion. Drizzle regenerates schema changes but not hand-written data backfills or manual SQL. Record any statements that must be carried into the squashed migration. If their required order is unclear, stop and ask the user.

If there are no branch migration directories, stop and report that there is nothing to squash. If there is already exactly one valid pair, report that the branch is already squashed and avoid needless regeneration unless the user explicitly asks for it.

## Check Whether They Were Applied Locally

Ensure the development database is running, starting only its service when needed:

```bash
docker compose up -d db
docker compose exec -T db pg_isready -U postgres -d taxmaxi
```

Check whether the migrations table exists:

```bash
docker compose exec -T db psql -U postgres -d taxmaxi -Atc "SELECT to_regclass('drizzle.__drizzle_migrations');"
```

If it exists, list the applied migration names:

```bash
docker compose exec -T db psql -U postgres -d taxmaxi -Atc 'SELECT name FROM drizzle.__drizzle_migrations ORDER BY id;'
```

Compare the exact directory names with that output. Treat the branch migrations as applied if any selected name appears. An absent migrations table means none were applied.

## Restore a Main-only Database When Needed

Skip this section when none of the selected migrations were applied.

When at least one was applied:

1. State that the local Compose database volume will be deleted, then run `docker compose down -v`.
2. Switch to `main` with `git switch main`.
3. Start Postgres with `docker compose up -d db` and wait for `pg_isready` to succeed.
4. Run `mise x -- pnpm run db:migrate` to build the database from the migrations on `main`.
5. Switch back to the recorded branch before changing migration files.

If a command fails after switching branches, make a safe attempt to return to the recorded branch, then stop and report the failure. Never delete branch migrations while `main` is checked out.

## Replace the Migrations

1. Show the exact branch-owned directories one last time.
2. Remove only those directories. Use `git rm -r -- <directories>` for tracked files and remove only the explicitly listed paths for untracked files.
3. Force a fresh build of every buildable app and package except `www`, the `tax` CLI workspace, and `crawler`. This refreshes `@my/persistence` and all server-side dependents before migration generation:

   ```bash
   mise x -- pnpm exec turbo run build --filter='!www' --filter='!tax' --filter='!crawler' --force
   ```

   Stop if the build fails. Do not generate a migration from stale or failing package output.
4. Run:

   ```bash
   mise x -- pnpm run db:generate
   ```

5. Confirm generation produced exactly one new branch-owned directory containing exactly one `migration.sql` and one `snapshot.json`.
6. Inspect the generated SQL against the schema diff. Restore any required hand-written backfill or manual SQL in a dependency-safe position inside the single generated `migration.sql`; do not create another migration directory.
7. Inspect `git diff -- packages/persistence/drizzle` and confirm all migrations from `main` remain untouched.

## Verify

Apply the new migration to the main-only local database state:

```bash
mise x -- pnpm run db:migrate
```

Then run the persistence tests:

```bash
docker compose up -d db-test
mise x -- pnpm run test packages/persistence
```

Finish by reporting:

- the removed migration directory names;
- the new migration directory name;
- whether the local database had required a reset;
- the full build result;
- the migration and test results;
- any preserved hand-written SQL;
- the final `git status --short` output relevant to the migration paths.
