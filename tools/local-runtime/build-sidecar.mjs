import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseGoVersionMetadata,
  SIDECAR_ARTIFACT,
  SIDECAR_DEPENDENCY,
  SIDECAR_DEPENDENCY_VERSION,
  SIDECAR_MANIFEST_SCHEMA,
} from './runtime-core.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sidecarDirectory = join(repositoryRoot, 'sidecar');
const outputDirectory = join(repositoryRoot, 'release', 'local-agent-runtime');
const artifactPath = join(outputDirectory, SIDECAR_ARTIFACT);
const manifestPath = join(outputDirectory, 'alsniper-agent.manifest.json');
const temporarySuffix = `.tmp-${process.pid}`;
const temporaryArtifactPath = `${artifactPath}${temporarySuffix}`;
const temporaryManifestPath = `${manifestPath}${temporarySuffix}`;

function assertOwnedOutput(path) {
  const resolvedOutput = resolve(outputDirectory);
  const resolvedPath = resolve(path);
  if (resolvedPath !== resolvedOutput && !resolvedPath.startsWith(`${resolvedOutput}${sep}`)) {
    throw new Error('Refusing to write outside the local Agent runtime output directory.');
  }
}

async function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    const capture = (target) => (chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > 512 * 1024) {
        child.kill();
        rejectRun(new Error(`${command} produced excessive output.`));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.once('error', rejectRun);
    child.once('close', (code, signal) => {
      const stdoutText = Buffer.concat(stdout).toString('utf8');
      const stderrText = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) {
        rejectRun(new Error(`${command} failed (${signal ?? code})${stderrText === '' ? '' : `: ${stderrText}`}`));
        return;
      }
      resolveRun(stdoutText);
    });
  });
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function replaceFile(temporaryPath, destinationPath) {
  assertOwnedOutput(temporaryPath);
  assertOwnedOutput(destinationPath);
  await rm(destinationPath, { force: true });
  await rename(temporaryPath, destinationPath);
}

async function main() {
  await mkdir(outputDirectory, { recursive: true });
  assertOwnedOutput(temporaryArtifactPath);
  assertOwnedOutput(temporaryManifestPath);
  await Promise.all([
    rm(temporaryArtifactPath, { force: true }),
    rm(temporaryManifestPath, { force: true }),
  ]);

  try {
    await run('go', [
      '-C', sidecarDirectory,
      'build',
      '-trimpath',
      '-buildvcs=true',
      '-ldflags=-s -w',
      '-o', temporaryArtifactPath,
      './cmd/alsniper-agent',
    ], {
      env: {
        ...process.env,
        CGO_ENABLED: '0',
        GOARCH: 'amd64',
        GOOS: 'windows',
      },
    });

    const versionMetadata = await run('go', ['version', '-m', temporaryArtifactPath]);
    const audited = parseGoVersionMetadata(versionMetadata);
    const artifactHash = await sha256File(temporaryArtifactPath);
    const manifest = {
      schemaVersion: SIDECAR_MANIFEST_SCHEMA,
      artifact: SIDECAR_ARTIFACT,
      sha256: artifactHash,
      dependency: {
        module: SIDECAR_DEPENDENCY,
        version: SIDECAR_DEPENDENCY_VERSION,
        sum: audited.dependencySum,
      },
      target: {
        goos: audited.goos,
        goarch: audited.goarch,
        cgoEnabled: audited.cgoEnabled,
      },
      build: {
        goVersion: audited.goVersion,
        vcsRevision: audited.vcsRevision,
        vcsModified: audited.vcsModified,
      },
    };
    await writeFile(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

    await replaceFile(temporaryArtifactPath, artifactPath);
    await replaceFile(temporaryManifestPath, manifestPath);

    const persistedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (persistedManifest.sha256 !== await sha256File(artifactPath)) {
      throw new Error('The persisted local sidecar artifact failed its SHA-256 verification.');
    }
    console.log(`Built ${SIDECAR_ARTIFACT} (${artifactHash}).`);
  } finally {
    await Promise.all([
      rm(temporaryArtifactPath, { force: true }),
      rm(temporaryManifestPath, { force: true }),
    ]);
  }
}

await main();
