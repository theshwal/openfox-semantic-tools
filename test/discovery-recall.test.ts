import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  localRecall,
  MAX_LOCAL_RECALL_CANDIDATES,
  MAX_RECALL_SCANNED_FILES,
} from '../src/discovery/recall.ts'
import { MAX_FILE_BYTES } from '../src/discovery/read.ts'

async function tree() {
  const root = await mkdtemp(join(tmpdir(), 'local-recall-'))
  await mkdir(join(root, 'src', 'tenant'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'hidden'), { recursive: true })
  await writeFile(join(root, 'src', 'tenant', 'export.ts'), 'export function tenantExport() { return "tenant export scope" }\n')
  await writeFile(join(root, 'src', 'misc.ts'), 'export const helper = "unrelated"\n')
  await writeFile(join(root, 'node_modules', 'hidden', 'tenant.ts'), 'tenant export\n')
  return root
}

test('local recall ranks path/content signals and excludes vendor directories', async () => {
  const root = await tree()
  const result = await localRecall(root, 'tenant export')
  assert.ok(result.scannedFiles >= 2)
  assert.ok(result.ignoredDirectories >= 1)
  assert.equal(result.candidates[0].path, 'src/tenant/export.ts')
  assert.ok(result.candidates[0].score > 0)
  assert.ok(!result.candidates.some((candidate) => candidate.path.includes('node_modules')))
})

test('local recall never returns more than the semantic candidate bound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-recall-bound-'))
  for (let i = 0; i < MAX_LOCAL_RECALL_CANDIDATES + 8; i += 1) {
    await writeFile(join(root, `tenant-${i}.ts`), `export const tenant${i} = "tenant"\n`)
  }
  const result = await localRecall(root, 'tenant')
  assert.equal(result.candidates.length, MAX_LOCAL_RECALL_CANDIDATES)
})

test('oversized, binary and symlink files are not recall candidates', async () => {
  const root = await tree()
  await writeFile(join(root, 'oversized.ts'), Buffer.alloc(MAX_FILE_BYTES + 1, 97))
  await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
  await symlink(join(root, 'src', 'tenant', 'export.ts'), join(root, 'linked.ts'))

  const result = await localRecall(root, 'tenant')
  assert.ok(!result.candidates.some((candidate) => ['oversized.ts', 'binary.bin', 'linked.ts'].includes(candidate.path)))
})

test('recall scan is hard-bounded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-recall-scan-bound-'))
  for (let i = 0; i < MAX_RECALL_SCANNED_FILES + 25; i += 1) {
    await writeFile(join(root, `f-${String(i).padStart(4, '0')}.ts`), 'const x = "needle"\n')
  }
  const result = await localRecall(root, 'needle')
  assert.equal(result.scannedFiles, MAX_RECALL_SCANNED_FILES)
})
