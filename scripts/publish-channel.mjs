// @ts-nocheck
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const [, , rawChannel, ...rawArgs] = process.argv
const validChannels = new Set(['beta', 'nightly'])

if (!validChannels.has(rawChannel)) {
  console.error('Usage: node scripts/publish-channel.mjs <beta|nightly> [--dry-run]')
  process.exit(1)
}

const dryRun = rawArgs.includes('--dry-run')
const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const packageJsonPath = path.join(rootDir, 'package.json')
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
const { name, version: currentVersion } = packageJson

function parseVersion(version) {
  const match = version.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/,
  )

  if (!match) {
    throw new Error(`Unsupported version format: ${version}`)
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? '',
  }
}

function formatVersion({ major, minor, patch }, prerelease = '') {
  return `${major}.${minor}.${patch}${prerelease ? `-${prerelease}` : ''}`
}

function getNextStableBase(version) {
  const parsed = parseVersion(version)

  return {
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch + 1,
  }
}

function getTimestampSuffix(date = new Date()) {
  const parts = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
    String(date.getUTCHours()).padStart(2, '0'),
    String(date.getUTCMinutes()).padStart(2, '0'),
  ]

  return parts.join('')
}

function getNextBetaVersion(version) {
  const parsed = parseVersion(version)

  if (parsed.prerelease.startsWith('beta.')) {
    const currentNumber = Number(parsed.prerelease.split('.')[1] ?? '0')
    return formatVersion(parsed, `beta.${currentNumber + 1}`)
  }

  return formatVersion(getNextStableBase(version), 'beta.0')
}

function getNextNightlyVersion(version) {
  return formatVersion(
    getNextStableBase(version),
    `nightly.${getTimestampSuffix()}`,
  )
}

const nextVersion =
  rawChannel === 'beta'
    ? getNextBetaVersion(currentVersion)
    : getNextNightlyVersion(currentVersion)

console.log(`${name}: ${currentVersion} -> ${nextVersion}`)
console.log(`npm dist-tag target: ${rawChannel}`)

if (dryRun) {
  process.exit(0)
}

execFileSync('npm', ['version', nextVersion, '--no-git-tag-version'], {
  cwd: rootDir,
  stdio: 'inherit',
})

execFileSync('npm', ['publish', '--tag', rawChannel], {
  cwd: rootDir,
  stdio: 'inherit',
})
