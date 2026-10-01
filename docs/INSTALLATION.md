# Installation

Two ways to get this plugin into OpenFox. Both need **no provider credential**
and no account with any vendor.

| Recipe | Use when |
| --- | --- |
| [A — source checkout, absolute local path](#a-source-checkout--absolute-local-path) | Always. This is the supported path and the one the harness executes. |
| [B — packed tarball](#b-packed-tarball-not-installable) | Never, for installation. Documented because it fails, and why matters. |

Both end in the same host operation: OpenFox copies a directory into its plugins
directory and builds it there.

## What the host actually does

From OpenFox `v2.0.157` and `v2.0.160`, `src/server/plugins/install.ts`:

- `installPluginFromPath(sourcePath, pluginsDir)` copies the directory
  recursively into `<pluginsDir>/<basename>`, skipping `node_modules` and
  `.git`, then calls `buildIfNeeded()`.
- `buildIfNeeded(directory)` reads `package.json`; **if and only if
  `scripts.build` exists** it runs `npm install` and then `npm run build` in
  that directory. A package with no `build` script is copied as-is.
- `installPluginFromGithub(githubUrl, pluginsDir)` does
  `git clone --depth 1 <cloneUrl>` and then the same `buildIfNeeded()`.

Two consequences, both observed in the source of both releases:

1. **A GitHub tree or tag URL does not pin the OpenFox installer version, and
   it does not pin a tag either.** `parseGithubUrl()` keeps only `owner/repo`
   from the URL — everything after the repository name (a `/tree/<ref>` or
   `/tree/<sha>` suffix) is discarded. The clone is `--depth 1` from the
   **default branch HEAD**. Passing
   `https://github.com/theshwal/openfox-semantic-tools/tree/v0.1.0` installs
   whatever `main` points at, not `v0.1.0`.
2. **The packed tarball cannot be installed at all.** `npm pack` applies the
   `files` allowlist (`dist`, `README.md`, `docs`), so a `.tgz` carries no
   `src/` and no `tsconfig.json`. The manifest still declares `scripts.build`,
   so `buildIfNeeded()` tries to compile, fails, and the install is rejected
   (see Recipe B). There is no build-config-free install path here.

Because of (1), the reliable recipe is a **versioned source checkout plus the
absolute local path**, so the tree you verified is the tree that gets built.

## Recipe A — source checkout, absolute local path

This recipe is **executed** by the isolated harness, not merely described:
`npm run harness` calls `POST /api/plugins/install` with the checkout's absolute
path and then asserts the built entry exists inside the host's own copy.

```bash
# 1. Clone a specific tag, shallowly, into a path you own.
git clone --depth 1 --branch v0.1.0 \
  https://github.com/theshwal/openfox-semantic-tools.git \
  "$HOME/src/openfox-semantic-tools-v0.1.0"

# 2. Resolve the absolute path. OpenFox copies from a filesystem path, so it
#    must be absolute — a relative path resolves against the host's cwd.
cd "$HOME/src/openfox-semantic-tools-v0.1.0"
PLUGIN_SRC="$(pwd -P)"

# 3. Offline checks first, so a broken tree is caught before it is installed.
npm ci --ignore-scripts
npm run check
```

Then install it through OpenFox's plugin installation flow, choosing the
**local path / install from path** option and giving `$PLUGIN_SRC`. Over HTTP
that is:

```bash
curl -X POST http://127.0.0.1:<port>/api/plugins/install \
  -H 'Content-Type: application/json' \
  -d "{\"path\":\"$PLUGIN_SRC\"}"
```

What happens next, per `buildIfNeeded()`:

- the directory is copied to `<pluginsDir>/<basename>`, without `node_modules`
  or `.git`;
- because `scripts.build` exists, OpenFox runs `npm install` **and**
  `npm run build` inside the copy. `tsc` therefore must be reachable: the
  copied tree has no `node_modules` of its own, and `npm install` restores the
  dev dependencies the build needs.

A checkout with its own `node_modules` is fine: it is excluded from the copy,
so the host rebuilds from a clean tree rather than reusing yours.

The directory is named after the checkout, but the plugin keeps its manifest
identity: the API id stays the manifest `packageName`, not the directory name.

Verify after installing:

```bash
ls <pluginsDir>/<basename>/dist/index.js
```

If `dist/index.js` is missing after the install, the build step did not run:
check that `scripts.build` survived the copy and that `npm` is on the host's
`PATH`.

**Environment note for a self-hosted instance.** The installer's `npm install`
and `npm run build` inherit the host's environment. If an inherited
`npm_config_prefix`/`NPM_CONFIG_PREFIX` points at another installation tree, npm
will write there instead of inside the plugin copy. Unset both in the host's
service environment before installing.

## Recipe B — packed tarball (not installable)

**This recipe does not produce a working installation.** It is documented to
explain *why*, and because a `.tgz` in hand is a common dead end.

```bash
# Unpack a tarball someone gave you.
mkdir -p "$HOME/src/semantic-tools-pkg"
tar -xzf openfox-semantic-tools-0.1.0.tgz -C "$HOME/src/semantic-tools-pkg"
# -> $HOME/src/semantic-tools-pkg/package
```

Installing that directory through the local-path route **fails**. The manifest
still declares `scripts.build`, so `buildIfNeeded()` runs `npm install` and
`npm run build` inside the copy. The unpacked directory has no `src/` and no
`tsconfig.json`, `tsc` fails, and in both released hosts that error is not
caught: `buildIfNeeded()` lets it propagate and `installPluginFromPath` rejects,
so the install returns **HTTP 500**. Recipe B therefore describes what a `.tgz`
is worth here, which is: nothing installable.

If you need a tarball to be installable, use Recipe A and build from a source
checkout. That is the only path this project supports, and it is the path the
harness executes.

There is **no npm publication** of this package and no registry submission in
this project, and none is planned as part of #13.

## Post-install configuration

Enable the plugin, then set **global plugin settings**:

| Setting | Meaning |
| --- | --- |
| `backend` | Label for the intended backend. It never supplies an endpoint. |
| `endpoint` | The **full POST URL**. Required, including with the `jev` selector. |
| `model` | Optional model id forwarded to the provider. |
| `apiKey` | Optional secret. Never logged, never in a report or a cache key. |
| `timeoutMs` | Bounded request timeout. |
| `endpointClass` | Optional `local`/`private`/`remote` override. |
| `egressPolicy` | `allow` (default), `block-remote-automatic`, `block-remote-all`. |
| `cacheEnabled` / `cacheTtlMs` / `cacheMaxEntries` | Optional decision cache, off by default. |
| `calibrationProfileJson` / `calibrationOverridesJson` / `runtimeVersion` | Calibration layer. See [CALIBRATION.md](./CALIBRATION.md). |

Tool registration does not grant access: add the tools you want to the agent's
allowed tools. See [PROVIDERS.md](./PROVIDERS.md) and the README for the
`allowedTools` caveat and the usage skills.

## Offline verification without any credential

The whole offline path works with no endpoint and no key:

```bash
npm run check               # typecheck + tests + build
npm run evaluate            # synthetic fixture evaluation, no claim
npm run conformance:smoke   # local System One stub, no credentials
npm run verify:experiment   # labelled fixtures, scripted transport
npm run verify:replay       # replays committed number-only snapshots
```

To exercise the plugin inside a real OpenFox host, install the public OpenFox
package into a throwaway tree first:

```bash
HARNESS_PKG_DIR=/tmp/of-harness-2.0.160 scripts/setup-harness.sh
HARNESS_PKG_DIR=/tmp/of-harness-2.0.160 npm run harness
```

Use one `HARNESS_PKG_DIR` per OpenFox version. The setup script refuses to reuse
a tree that holds a different release, and it prints the version read back from
the installed tree — never the version that was requested.
