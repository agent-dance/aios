import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createConnection } from 'node:net';
import test from 'node:test';
import {
  createDesktopShutdownChannel,
  createDesktopShutdownPipeName,
  DESKTOP_SHUTDOWN_READY_HANDSHAKE,
} from './desktop-shutdown-channel.mjs';

const FIXED_RANDOM = Buffer.from('00112233445566778899aabbccddeeff', 'hex');

function authenticatedHandshake(channel, clientPid) {
  const mac = createHmac('sha256', Buffer.from(channel.secret, 'hex'))
    .update(`AIOS_DESKTOP_SHUTDOWN_AUTH_V1\0${channel.pipePath}\0${clientPid}`)
    .digest('hex');
  return `${DESKTOP_SHUTDOWN_READY_HANDSHAKE}PID:${clientPid}\nMAC:${mac}\n`;
}

test('desktop shutdown pipe uses exactly 128 random bits in the local namespace', () => {
  assert.equal(
    createDesktopShutdownPipeName(() => FIXED_RANDOM),
    String.raw`\\.\pipe\alsniper-desktop-shutdown-00112233445566778899aabbccddeeff`,
  );
  assert.throws(() => createDesktopShutdownPipeName(() => Buffer.alloc(15)), /random source/u);
});

test('desktop channel accepts the fixed readiness handshake with its authenticated proof', async (context) => {
  if (process.platform !== 'win32') {
    context.skip('Windows named pipes are required.');
    return;
  }
  const channel = await createDesktopShutdownChannel({
    random: (size) => size === 16 ? FIXED_RANDOM : Buffer.alloc(size, 0x5a),
  });
  channel.expectClientPid(process.pid);
  const socket = createConnection(channel.pipePath);
  socket.once('connect', () => socket.write(authenticatedHandshake(channel, process.pid)));
  await channel.ready;
  assert.equal(socket.destroyed, false);
  const ended = new Promise((resolve) => socket.once('end', resolve));
  socket.resume();
  channel.requestShutdown();
  await ended;
  socket.destroy();
  channel.dispose();
});

test('invalid client cannot consume the desktop readiness endpoint', async (context) => {
  if (process.platform !== 'win32') {
    context.skip('Windows named pipes are required.');
    return;
  }
  const channel = await createDesktopShutdownChannel();
  channel.expectClientPid(process.pid);
  const invalidSocket = createConnection(channel.pipePath);
  const invalidClosed = new Promise((resolve) => invalidSocket.once('close', resolve));
  invalidSocket.once('connect', () => invalidSocket.end(
    `${DESKTOP_SHUTDOWN_READY_HANDSHAKE}PID:${process.pid}\nMAC:${'0'.repeat(64)}\n`,
  ));
  await invalidClosed;

  const validSocket = createConnection(channel.pipePath);
  validSocket.once('connect', () => validSocket.write(authenticatedHandshake(channel, process.pid)));
  await channel.ready;
  assert.equal(validSocket.destroyed, false);
  channel.dispose();
  validSocket.destroy();
});

test('a complete proof received before PID binding is revalidated without another data event', async (context) => {
  if (process.platform !== 'win32') {
    context.skip('Windows named pipes are required.');
    return;
  }
  const channel = await createDesktopShutdownChannel();
  const socket = createConnection(channel.pipePath);
  const proofWritten = new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write(authenticatedHandshake(channel, process.pid), resolve);
    });
  });
  await proofWritten;
  await new Promise((resolve) => setImmediate(resolve));
  channel.expectClientPid(process.pid);
  await channel.ready;
  channel.dispose();
  socket.destroy();
});
