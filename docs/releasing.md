# Release process

Releases are verified before they are published, and publishing is automated
from the tag. The gate is the same gate either way: `bun run release:check` must
pass locally, and the release workflow runs exactly that script before it
publishes anything.

## One-time setup

Everything below attaches to a repository that contains
`.github/workflows/release.yml`; a `release` environment and npm trusted
publishing cannot be created without one. If the repository does not exist
yet, create it first:

```sh
# A public repository for this project, with the work on `main`.
gh repo create fixate-on --public --source=. --remote=origin
git push origin HEAD:main
git branch --set-upstream-to=origin/main main
```

`main` is the branch CI runs on and the branch the release tag must descend
from, so `main` is what must carry the work. A tag on a commit that only exists
on a feature branch is rejected by the release gate, by design.

Publishing then depends on three more pieces of repository configuration that
only the maintainer can create. None of them is a secret, and none of them is a
token.

1. **Create the `release` environment.** Settings → Environments → New
   environment, named `release`. **Add required reviewers.** This is the human
   gate: a tag push starts the gate job, and approving this environment is what
   publishes to npm. Do not skip the reviewers — without them, any tag push
   publishes.
2. **Enable private vulnerability reporting.** Settings → Security →
   Advanced. GitHub's private vulnerability reporting links to it; the link
   resolves to nothing until it is on.
3. **Configure npm trusted publishing.** On npmjs.com, the package's
 *Trusted Publisher* setting points at this repository and the
   `.github/workflows/release.yml` workflow. npm then exchanges a short-lived
   OIDC token for a publish credential, so there is no `NPM_TOKEN` anywhere.
   `npm` CLI 11.5.1 or newer is required on the runner; GitHub-hosted runners
   satisfy this today, and the publish job fails loudly rather than silently if
   that stops being true.

Mark three of the four CI jobs as required status checks on `main`. GitHub
shows the job's `name:`, not its id, so look for **Lockfile is in sync**,
**Check** and **Contracts**.

Leave the fourth — the `platform` matrix, which GitHub shows as three separate
checks, **Filesystem (ubuntu-latest)**, **Filesystem (macos-latest)** and
**Filesystem (windows-latest)** — unrequired, deliberately. A flaky Windows runner
should not be able to block a release on a plugin whose behaviour is
platform-independent above the two filesystem suites; it still runs, and still
reports. If a release ever *does* depend on it, promote it then.

## Prepare

1. Work on a branch based on `main`. `main` is what CI runs on.
2. Update the version in `package.json`. Nothing else carries a version —
   `bun.lock` records the package *name*, not its version, and
   `packageManager` records the bun version.
3. Record any change to the compatibility floor or the public tool surface
   in the release notes.
4. Run the gate:

   ```sh
   bun install --frozen-lockfile
   npm config get ignore-scripts     # false, or the publish-time nets do not exist
   bun run release:check
   ```

   `release:check` and the CI `contracts` job run the same gate — bundle,
   check, dependency audit — so a green local gate and a green CI run mean the
   same thing.

5. Inspect the artifact. Pack it once and read it:

   ```sh
   bun run bundle && bun pm pack --destination dist
   tar -tzf dist/fixate-on-1.0.0.tgz | sort
   ```

    Expect **12** entries:

   - `package.json` (1)
   - the three generated bundles under `plugin/fixate-on/` (3)
   - the three published type declarations (3)
   - `completion-verdict.schema.json`, the judge verdict wire contract (1)
   - the integration document a host author needs (1):
     `docs/tui-integration.md`
   - `README.md`, `CONTRIBUTING.md`,
     `LICENSE` (4)

   Nothing from `src/`, `test/`, `examples/`, `.github/` or
   `hack/`, and not the maintainer's own runbook: `files` lists
   the integration document individually rather than the `docs/`
   directory, which is why a new file dropped into `docs/` cannot reach the
   tarball at all.

    Do not record a size. `bun pm pack --destination <dir>` prints
    `Packed size`; any number written down here is wrong the moment a dependency or a document changes.

   This is the last point at which a bad artifact is cheap to catch — the
   workflow publishes the bytes the gate produced, unchanged.

## The safety nets, and what each one actually covers

`bun pm pack` and `bun publish` run **no** lifecycle scripts (measured), and the
generated bundle is gitignored, so a pack performed before `bun run bundle`
produces a tarball that cannot load. `npm publish` from a CHECKOUT is
different: it runs `prepack` (which is `bun run bundle`) and then
`prepublishOnly` (which is `bun run release:check`).

**`npm publish <tarball>` runs neither, and neither does `bun publish
<tarball>`.** Publishing a
`.tgz` fires no script under any client. So every npm-side net below exists for
the checkout form of the command only. Publishing a tarball is publishing an
artifact whose verification happened when it was built — which is exactly what
the release workflow does, deliberately, and why its `publish` job depends on
the `gate` job that produced the bytes. The break-glass commands further down
publish a tarball, so they carry no net at all: read the tarball's member list
against the expected shape below, or run `release:check` yourself first.

Do not change `prepack` to `prepare`: `prepare` also fires on `npm install` from
a git URL, which is a worse failure mode. The bun path is covered by the other
two mechanisms:

- `release:check` begins with `bun run bundle`, so the pack step always has
  something to pack.

There is a second net, and it is the only one that gates rather than
repairs. `prepublishOnly` is `bun run release:check`, so `npm publish` from a
checkout runs the entire artifact and quality gate before anything is
published. `prepack` only ever rebuilt the bundle; it would happily ship an
unverified tarball.

**Both npm-side nets are disabled by one setting.** If any reachable `.npmrc`
sets `ignore-scripts=true`, npm skips `prepack` AND `prepublishOnly`. That is
the default in the maintainer's own `~/.npmrc` on this machine. Check it
before relying on either net:

```sh
npm config get ignore-scripts   # must print false for these nets to exist
```

## Publish

1. Merge to `main`. Wait for the required checks.
2. Create and push an **annotated** tag at that commit:

   ```sh
   git tag -a v1.0.0 -m "fixate-on 1.0.0"
   git push origin v1.0.0
   ```

   The tag must be exactly `v<version>`. The workflow rejects anything else
   before it spends a minute on the gate.

3. The `gate` job checks the tag against `package.json`, runs
   `bun run release:check`, packs, and uploads the tarball as a workflow
   artifact. **This job has no elevated permission** — nothing about verifying a
   release needs more than read access.
4. The `publish` job then waits on the `release` environment. Approve it. The job
   downloads the exact tarball the gate produced and runs
   `npm publish <absolute path> --provenance --access public`. It is the only job
   in the repository with `id-token: write`.

    The path is absolute on purpose. `npm publish dist/fixate-on-1.0.0.tgz` is
 **not** treated as a file: npm's specifier resolver matches the `owner/repo`
    GitHub shorthand first, so it attempts a git lookup and dies
    with "Repository not found" — an error naming a repository that does not
    exist rather than the path that was wrong. `./dist/…` and absolute paths both
    work.

5. Confirm the published version, then write the GitHub release notes.

### What the workflow deliberately does not do

- **No long-lived registry token.** Trusted publishing replaces it.
- **No second provenance attestation.** `npm publish --provenance` already emits
  a statement for these exact bytes. Adding `attest-build-provenance` would
  widen the permission surface without adding evidence.
- **No rebuild at publish time.** `npm publish <tarball>` publishes the artifact
  byte-for-byte. The publish job cannot accidentally ship something the gate did
  not check.
- **No `bun publish`.** Bun skips lifecycle scripts, which is fine for packing
  but means npm is the right client for the OIDC handshake and the provenance
  statement.

## If a release goes wrong

An npm version cannot be reused and a version cannot be unpublished after 72
hours. So:

- **The gate failed** — nothing was published. Fix, re-tag with a new version.
- **The publish job failed after approval** — the version may or may not be
  live. Check the registry before retrying; `npm view fixate-on versions` is
  authoritative. Re-running the workflow on the same tag is safe once the version
  is confirmed unpublished, and unsafe if it is not.
- **The artifact is wrong** — release a patch. Do not rebuild or edit an
  artifact in place after the fact.

### Break-glass: publishing by hand

If the release environment or trusted publishing is misconfigured, the
artifact from the **gate job's workflow artifact** can be published manually.

**Which tarball matters, because nothing downstream can tell them apart.**
Publishing a `.tgz` runs no lifecycle script under either client, so a local
`bun pm pack` in a checkout whose `plugin/fixate-on/` is stale produces
a package that installs and then cannot load. So:

- **The gate job's artifact is the safe one.** Download it, and check it first.
- **A locally packed tarball is not**, and nothing will check it for you.

Whichever you use, check the shape before publishing. The name
`fixate-on` is consumed permanently on first publish, and this path has no
environment gate, no provenance statement and no gate run:

```sh
# Works on a tarball from EITHER source. From the repository root — bun reads
# the local package.json, so run this where one exists, not from a directory
# holding only the.tgz.
bun publish dist/fixate-on-X.Y.Z.tgz --access public

# npm needs the./ prefix for a relative path, per the note above.
npm publish ./dist/fixate-on-X.Y.Z.tgz --access public
```

To check a tarball before publishing it, read its member list against the
expected shape from the Prepare section:

```sh
   tar -tzf dist/fixate-on-X.Y.Z.tgz | sed 's|^package/||' | sort
# The count, the three generated bundles, and no
# scripts/e2e-harness/.
```

Use this to recover, then fix the configuration before the next release. Prefer
re-running the workflow on the same tag once it is fixed: that path has the gate,
the environment approval and the provenance statement, and this one has none of
the three.
