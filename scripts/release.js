import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import crypto from 'crypto'
import https from 'https'
import AdmZip from 'adm-zip'

function loadEnv() {
  const envPath = path.join(process.cwd(), '.env')
  if (!fs.existsSync(envPath)) return

  const content = fs.readFileSync(envPath, 'utf8')
  content.split('\n').forEach(line => {
    const match = line.trim().match(/^([^=]+)=(.*)$/)
    if (!match) return

    const key = match[1].trim()
    const value = match[2].trim().replace(/^['"]|['"]$/g, '')
    if (!process.env[key]) {
      process.env[key] = value
    }
  })
}

loadEnv()

const args = process.argv.slice(2)
let versionArg = null
let semverType = null
let channel = 'stable'
let prerelease = false
let required = false

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--version' || arg === '-v') {
    versionArg = args[i + 1]
    i++
  } else if (arg === '--patch') {
    semverType = 'patch'
  } else if (arg === '--minor') {
    semverType = 'minor'
  } else if (arg === '--major') {
    semverType = 'major'
  } else if (arg === '--channel') {
    channel = args[i + 1] || channel
    i++
  } else if (arg === '--beta') {
    channel = 'beta'
    prerelease = true
  } else if (arg === '--alpha') {
    channel = 'alpha'
    prerelease = true
  } else if (arg === '--rc') {
    channel = 'rc'
    prerelease = true
  } else if (arg === '--required') {
    required = true
  }
}

if (!['stable', 'alpha', 'beta', 'rc'].includes(channel)) {
  console.error(`Invalid release channel: ${channel}`)
  process.exit(1)
}

if (channel !== 'stable') {
  prerelease = true
}

const root = process.cwd()
const pkgPath = path.join(root, 'package.json')
const lockPath = path.join(root, 'package-lock.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const currentVersion = pkg.version

function bumpVersion(version, type) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)(-.+)?$/)
  if (!match) {
    throw new Error(`Cannot bump invalid semver version: ${version}`)
  }

  const parts = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (type === 'major') {
    parts[0]++
    parts[1] = 0
    parts[2] = 0
  } else if (type === 'minor') {
    parts[1]++
    parts[2] = 0
  } else {
    parts[2]++
  }
  return parts.join('.')
}

const nextVersion = versionArg || bumpVersion(currentVersion, semverType || 'patch')
const owner = process.env.GITHUB_OWNER || 'Straniksss'
const repo = process.env.GITHUB_REPO || 'Aventra-Browser'
const branch = process.env.GITHUB_RELEASE_BRANCH || 'main'
const token = process.env.GITHUB_TOKEN

console.log(`Preparing Aventra Browser release: ${currentVersion} -> ${nextVersion}`)
console.log(`Release channel: ${channel}`)

function updateJsonFile(filePath, updateFn) {
  if (!fs.existsSync(filePath)) return
  const json = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  updateFn(json)
  fs.writeFileSync(filePath, JSON.stringify(json, null, 2) + '\n', 'utf8')
}

function syncPackageVersion() {
  pkg.version = nextVersion
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

  updateJsonFile(lockPath, lock => {
    lock.name = pkg.name
    lock.version = nextVersion
    if (lock.packages?.['']) {
      lock.packages[''].name = pkg.name
      lock.packages[''].version = nextVersion
    }
  })
}

function createZip(zipPath, sourceDir) {
  const zip = new AdmZip()
  zip.addLocalFolder(sourceDir, '')
  zip.addFile('update.json', Buffer.from(JSON.stringify({
    version: nextVersion,
    channel,
    platform: 'windows',
    arch: 'x64',
    createdAt: new Date().toISOString()
  }, null, 2), 'utf8'))
  zip.writeZip(zipPath)
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

function githubRequest(method, urlPath, body, contentType = 'application/json', redirectCount = 0) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!token) {
      rejectPromise(new Error('GITHUB_TOKEN is missing from environment or .env.'))
      return
    }

    if (redirectCount > 5) {
      rejectPromise(new Error('GitHub API redirect limit exceeded.'))
      return
    }

    const url = urlPath.startsWith('http')
      ? new URL(urlPath)
      : new URL(`https://api.github.com${urlPath}`)

    const headers = {
      Authorization: `token ${token}`,
      'User-Agent': 'AventraBrowser-Release-Script',
      Accept: 'application/vnd.github+json'
    }

    if (body) {
      headers['Content-Type'] = contentType
      headers['Content-Length'] = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body)
    }

    const req = https.request({
      method,
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const nextMethod = res.statusCode === 303 ? 'GET' : method
          const nextBody = nextMethod === 'GET' ? null : body
          githubRequest(nextMethod, res.headers.location, nextBody, contentType, redirectCount + 1)
            .then(resolvePromise)
            .catch(rejectPromise)
          return
        }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolvePromise(JSON.parse(text))
          } catch {
            resolvePromise(text)
          }
        } else {
          rejectPromise(new Error(`GitHub API returned ${res.statusCode}: ${text}`))
        }
      })
    })

    req.on('error', rejectPromise)
    if (body) req.write(body)
    req.end()
  })
}

async function uploadReleaseAsset(uploadBaseUrl, name, buffer) {
  console.log(`Uploading ${name}...`)
  await githubRequest(
    'POST',
    `${uploadBaseUrl}?name=${encodeURIComponent(name)}`,
    buffer,
    'application/octet-stream'
  )
}

async function run() {
  syncPackageVersion()

  console.log('Running build...')
  execSync('npm run build', { stdio: 'inherit' })

  const unpackedDir = path.join(root, 'release-build', 'win-unpacked')
  if (!fs.existsSync(unpackedDir)) {
    console.error(`Error: unpacked app folder not found at ${unpackedDir}`)
    process.exit(1)
  }

  const zipName = `AventraBrowser-${nextVersion}-win-x64.zip`
  const zipPath = path.join(root, 'release-build', zipName)
  console.log(`Packaging portable zip: ${zipName}`)
  createZip(zipPath, unpackedDir)

  const zipBuffer = fs.readFileSync(zipPath)
  const manifest = {
    version: nextVersion,
    channel,
    prerelease,
    required,
    platform: 'windows',
    arch: 'x64',
    packageName: zipName,
    packageUrl: `https://github.com/${owner}/${repo}/releases/download/v${nextVersion}/${zipName}`,
    sha256: sha256File(zipPath),
    size: zipBuffer.length,
    releaseNotes: [
      'Aventra Browser release'
    ],
    publishedAt: new Date().toISOString()
  }

  const latestPath = path.join(root, 'latest.json')
  const channelManifestPath = path.join(root, `latest-${channel}.json`)
  fs.writeFileSync(latestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  fs.writeFileSync(channelManifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  if (!token) {
    console.log('GITHUB_TOKEN is missing; local release artifacts and manifests were generated only.')
    console.log(`Zip: ${zipPath}`)
    return
  }

  console.log('Staging release metadata...')
  try {
    execSync('git add package.json package-lock.json latest.json latest-*.json scripts/release.js', { stdio: 'inherit' })
    execSync(`git commit -m "Release Aventra Browser v${nextVersion}"`, { stdio: 'inherit' })
    execSync(`git tag v${nextVersion}`, { stdio: 'inherit' })
    execSync(`git push origin ${branch}`, { stdio: 'inherit' })
    execSync(`git push origin v${nextVersion}`, { stdio: 'inherit' })
  } catch (err) {
    console.warn('Warning: git commit/tag/push failed; continuing with GitHub release creation.', err.message)
  }

  console.log('Creating GitHub release...')
  const release = await githubRequest('POST', `/repos/${owner}/${repo}/releases`, JSON.stringify({
    tag_name: `v${nextVersion}`,
    target_commitish: branch,
    name: `Aventra Browser v${nextVersion}`,
    body: `Aventra Browser v${nextVersion} release.`,
    draft: false,
    prerelease
  }))

  const uploadBaseUrl = release.upload_url.replace(/\{.*?\}$/, '')
  await uploadReleaseAsset(uploadBaseUrl, path.basename(latestPath), fs.readFileSync(latestPath))
  await uploadReleaseAsset(uploadBaseUrl, path.basename(channelManifestPath), fs.readFileSync(channelManifestPath))
  await uploadReleaseAsset(uploadBaseUrl, zipName, zipBuffer)

  console.log('Release process completed successfully.')
}

run().catch(err => {
  console.error('Release failed:', err)
  process.exit(1)
})
