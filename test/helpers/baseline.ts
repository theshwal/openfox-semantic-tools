/**
 * The single declared OpenFox compatibility baseline.
 *
 * It lives in `package.json` as `openfox.compatibilityBaseline`, next to the
 * peer range it governs, because that file is readable from the shell harness,
 * from the tests and from the docs without a second copy drifting out of sync.
 *
 * `scripts/setup-harness.sh` reads the same field, so raising the baseline is a
 * one-line edit. The tests below assert that the peer range, the harness setup
 * and the docs all still name it, so a partial bump fails the suite instead of
 * shipping.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export const PROJECT_ROOT = resolve(import.meta.dirname, '../..')

export interface OpenFoxManifest {
  openfox: {
    apiVersion: number
    compatibilityBaseline: string
    capabilities: string[]
  }
  peerDependencies?: Record<string, string>
}

export async function readManifest(): Promise<OpenFoxManifest> {
  return JSON.parse(
    await readFile(resolve(PROJECT_ROOT, 'package.json'), 'utf8'),
  ) as OpenFoxManifest
}

export async function compatibilityBaseline(): Promise<string> {
  return (await readManifest()).openfox.compatibilityBaseline
}