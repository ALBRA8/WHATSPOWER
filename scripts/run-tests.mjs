#!/usr/bin/env node
/**
 * run-tests.mjs — Ejecutor multiplataforma de pruebas para WHATSPOWER.
 *
 * Ejecuta todas las pruebas en `tests/*.test.ts` sin `--test-isolation=process`
 * que falla/cuelga en Node >= 22.23 y Windows.
 * Compatible con Windows, Linux y CI.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const testsDir = join(process.cwd(), 'tests')
const testFiles = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.ts'))
  .sort()
  .map((f) => join('tests', f))

console.log(`[run-tests] Ejecutando ${testFiles.length} archivos de prueba en WHATSPOWER...`)

const args = ['--experimental-strip-types', '--test', ...testFiles]
const result = spawnSync(process.execPath, args, { stdio: 'inherit' })

process.exit(result.status ?? 0)
