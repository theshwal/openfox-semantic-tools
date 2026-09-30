#!/usr/bin/env node
/**
 * Emits the advisory workflow as a real OpenFox workflow file.
 *
 * This is a compiled entry point, shipped in the package and exposed through the
 * `bin` field, so an operator can run it from a plain installation with no dev
 * dependency and no TypeScript runtime:
 *
 *   openfox-semantic-workflow --out ~/.config/openfox/workflows
 *   openfox-semantic-workflow --print
 *
 * A workflow is a plain JSON file named `{id}.workflow.json`, loaded by OpenFox
 * from `{configDir}/workflows/` (user) or `{projectDir}/.openfox/workflows/`
 * (project, recommended and committable). Installing is opt-in: with no argument
 * this program writes nothing.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { ADVISORY_VERIFICATION_WORKFLOW } from './templates.js'

const args = process.argv.slice(2)
const printOnly = args.includes('--print')
const outIndex = args.indexOf('--out')
const target = outIndex >= 0 && args[outIndex + 1] ? resolve(args[outIndex + 1]) : null

const workflow = ADVISORY_VERIFICATION_WORKFLOW
const fileName = `${workflow.metadata.id}.workflow.json`
const document = JSON.stringify(workflow, null, 2) + '\n'

if (printOnly) {
  process.stdout.write(document)
} else if (target !== null) {
  await mkdir(target, { recursive: true })
  await writeFile(join(target, fileName), document)
  console.log(`Installed ${join(target, fileName)}`)
} else {
  // Nothing is written and nothing is written *about*: no personal path is
  // printed either, since this program may run in an environment whose config
  // directory the operator never intended to touch.
  console.error('Nothing written. Pass --out <dir> to install, or --print to preview.')
  process.exitCode = 1
}

if (!printOnly && target !== null) {
  // `getGlobalConfigDir` in OpenFox 2.0.160: ${XDG_CONFIG_HOME:-~/.config}/openfox
  const configDir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'openfox')
  console.log(
    'The workflow is advisory: the deterministic checks and the normal verifier always run,\n' +
      'and no transition branches on a semantic status.\n' +
      `User location:     ${join(configDir, 'workflows', fileName)}\n` +
      `Project location:  {projectDir}/.openfox/workflows/${fileName}  (recommended, committable)`,
  )
}
