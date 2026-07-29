import { packager } from '@electron/packager';
import { createReadStream } from 'node:fs';
import { access, cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webDistribution = join(repositoryRoot, 'dist');
const electronDistribution = join(repositoryRoot, 'dist-electron');
const releaseDirectory = join(repositoryRoot, 'release');
const temporaryPrefix = join(tmpdir(), 'alsniper-desktop-package-');

function isVersion(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value);
}

async function readRootManifest() {
  const rawManifest = await readFile(join(repositoryRoot, 'package.json'), 'utf8');
  const manifest = JSON.parse(rawManifest);
  const electronVersion = manifest.devDependencies?.electron;

  if (!isVersion(manifest.version) || !isVersion(electronVersion)) {
    throw new Error('Root package.json must contain exact application and Electron versions.');
  }

  return { appVersion: manifest.version, electronVersion };
}

async function assertBuildInputs() {
  await Promise.all([
    access(join(webDistribution, 'index.html')),
    access(join(electronDistribution, 'main.js')),
    access(join(electronDistribution, 'preload.cjs')),
  ]);
}

async function findFileDirectory(root, filename, depth = 3) {
  if (!root || depth < 0) return null;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (entry.isFile() && entry.name === filename) return root;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findFileDirectory(join(root, entry.name), filename, depth - 1);
    if (found !== null) return found;
  }
  return null;
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function readTrustedElectronChecksum(electronVersion, archiveName) {
  const electronPackageRoot = join(repositoryRoot, 'node_modules', 'electron');
  const packageManifest = JSON.parse(await readFile(join(electronPackageRoot, 'package.json'), 'utf8'));
  if (packageManifest.version !== electronVersion) {
    throw new Error('Installed Electron package does not match the pinned root version.');
  }

  const checksums = JSON.parse(await readFile(join(electronPackageRoot, 'checksums.json'), 'utf8'));
  const checksum = checksums[archiveName];
  if (typeof checksum !== 'string' || !/^[0-9a-f]{64}$/u.test(checksum)) {
    throw new Error(`Pinned Electron package has no trusted checksum for ${archiveName}.`);
  }
  return checksum;
}

async function findElectronZipDirectory(electronVersion) {
  const archiveName = `electron-v${electronVersion}-${process.platform}-${process.arch}.zip`;
  const trustedChecksum = await readTrustedElectronChecksum(electronVersion, archiveName);
  const cacheRoots = process.platform === 'win32'
    ? [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'electron', 'Cache')]
    : process.platform === 'darwin'
      ? [process.env.HOME && join(process.env.HOME, 'Library', 'Caches', 'electron')]
      : [
          process.env.XDG_CACHE_HOME && join(process.env.XDG_CACHE_HOME, 'electron'),
          process.env.HOME && join(process.env.HOME, '.cache', 'electron'),
        ];

  for (const cacheRoot of cacheRoots) {
    const directory = await findFileDirectory(cacheRoot, archiveName);
    if (directory !== null) {
      const archivePath = join(directory, archiveName);
      const archiveChecksum = await sha256(archivePath);
      if (archiveChecksum !== trustedChecksum) {
        throw new Error(`Cached Electron archive failed the pinned SHA-256 check: ${archiveName}.`);
      }
      return directory;
    }
  }
  return null;
}

function isOwnedTemporaryDirectory(directory) {
  const resolvedTemporaryRoot = resolve(tmpdir());
  const resolvedDirectory = resolve(directory);
  return (
    resolvedDirectory.startsWith(`${resolvedTemporaryRoot}${sep}`)
    && basename(resolvedDirectory).startsWith('alsniper-desktop-package-')
  );
}

async function createStagingDirectory(appVersion) {
  const stagingDirectory = await mkdtemp(temporaryPrefix);
  const includeCompiledAsset = (source) => (
    !source.endsWith('.map')
    && !source.endsWith(`${sep}smoke.js`)
    && !source.endsWith(`${sep}persistenceSmoke.js`)
  );

  await Promise.all([
    cp(webDistribution, join(stagingDirectory, 'dist'), {
      recursive: true,
      filter: includeCompiledAsset,
    }),
    cp(electronDistribution, join(stagingDirectory, 'dist-electron'), {
      recursive: true,
      filter: includeCompiledAsset,
    }),
  ]);

  const runtimeManifest = {
    name: 'alsniper-os-desktop',
    productName: 'AlSniper OS',
    version: appVersion,
    private: true,
    type: 'module',
    main: 'dist-electron/main.js',
  };
  await writeFile(
    join(stagingDirectory, 'package.json'),
    `${JSON.stringify(runtimeManifest, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );

  return stagingDirectory;
}

async function removeStagingDirectory(stagingDirectory) {
  if (!isOwnedTemporaryDirectory(stagingDirectory)) {
    throw new Error('Refusing to remove an unowned packaging directory.');
  }
  await rm(stagingDirectory, { recursive: true, force: true });
}

async function main() {
  await assertBuildInputs();
  const { appVersion, electronVersion } = await readRootManifest();
  const electronZipDir = await findElectronZipDirectory(electronVersion);
  const stagingDirectory = await createStagingDirectory(appVersion);

  try {
    const applicationPaths = await packager({
      dir: stagingDirectory,
      out: releaseDirectory,
      overwrite: true,
      asar: true,
      prune: false,
      name: 'AlSniper OS',
      executableName: 'AlSniper OS',
      appVersion,
      electronVersion,
      ...(electronZipDir === null ? {} : { electronZipDir }),
      platform: process.platform,
      arch: process.arch,
      appBundleId: 'com.alsniper.os',
      win32metadata: {
        CompanyName: 'AlSniper',
        FileDescription: 'AlSniper OS',
        InternalName: 'AlSniper OS',
        OriginalFilename: 'AlSniper OS.exe',
        ProductName: 'AlSniper OS',
      },
    });

    for (const applicationPath of applicationPaths) {
      console.log(`Packaged AlSniper OS: ${applicationPath}`);
    }
  } finally {
    await removeStagingDirectory(stagingDirectory);
  }
}

await main();
