const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const EmbyConnectionStore = require('../src/main/emby-connection-store');

async function createStore({ platform = 'win32', backend = 'OS credential store' } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'emby-connections-'));
  const filePath = path.join(directory, 'connections.json');
  const safeStorage = {
    getSelectedStorageBackend: () => backend,
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`encrypted:${value}`),
    decryptString: value => value.toString().replace(/^encrypted:/, '')
  };
  return {
    directory,
    filePath,
    safeStorage,
    store: new EmbyConnectionStore({ filePath, safeStorage, platform })
  };
}

test('stores API keys only as OS-encrypted data and never returns them to the renderer', async () => {
  const fixture = await createStore();
  try {
    const connections = await fixture.store.save({
      id: 'home',
      name: 'Home server',
      baseUrl: 'https://emby.example',
      token: 'private-api-key'
    });

    assert.equal(connections[0].hasToken, true);
    assert.equal(connections[0].tokenStorage, 'persistent');
    assert.equal(JSON.stringify(connections).includes('private-api-key'), false);

    const file = await fs.readFile(fixture.filePath, 'utf8');
    assert.equal(file.includes('private-api-key'), false);
    assert.deepEqual(await fixture.store.getForRequest('home'), {
      baseUrl: 'https://emby.example/emby',
      token: 'private-api-key'
    });
    const restartedStore = new EmbyConnectionStore({
      filePath: fixture.filePath,
      safeStorage: fixture.safeStorage,
      platform: 'win32'
    });
    assert.equal((await restartedStore.getForRequest('home')).token, 'private-api-key');
  } finally {
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }
});

test('keeps tokens session-only when Linux has no secure keyring backend', async () => {
  const fixture = await createStore({ platform: 'linux', backend: 'basic_text' });
  try {
    const [connection] = await fixture.store.save({
      id: 'portable',
      name: 'Portable server',
      baseUrl: 'http://localhost:8096',
      token: 'session-only-key'
    });
    assert.equal(connection.tokenStorage, 'session');
    assert.deepEqual(await fixture.store.getForRequest('portable'), {
      baseUrl: 'http://localhost:8096/emby',
      token: 'session-only-key'
    });

    const file = await fs.readFile(fixture.filePath, 'utf8');
    assert.equal(file.includes('session-only-key'), false);
    assert.equal(JSON.parse(file).connections[0].tokenCiphertext, null);
    const restartedStore = new EmbyConnectionStore({
      filePath: fixture.filePath,
      safeStorage: fixture.safeStorage,
      platform: 'linux'
    });
    await assert.rejects(restartedStore.getForRequest('portable'), /Save an API key/);
  } finally {
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }
});

test('preserves stored credentials on metadata edits and explicitly clears them on request', async () => {
  const fixture = await createStore();
  try {
    await fixture.store.save({
      id: 'home',
      name: 'Home server',
      baseUrl: 'https://emby.example',
      token: 'private-api-key'
    });
    await fixture.store.save({
      id: 'home',
      name: 'Renamed server',
      baseUrl: 'https://emby.example/emby'
    });
    assert.equal((await fixture.store.getForRequest('home')).token, 'private-api-key');

    const [connection] = await fixture.store.save({
      id: 'home',
      name: 'Renamed server',
      baseUrl: 'https://emby.example',
      clearToken: true
    });
    assert.equal(connection.hasToken, false);
    await assert.rejects(fixture.store.getForRequest('home'), /Save an API key/);
  } finally {
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }
});

test('does not overwrite malformed connection data', async () => {
  const fixture = await createStore();
  try {
    await fs.writeFile(fixture.filePath, '{invalid', 'utf8');
    await assert.rejects(fixture.store.save({
      id: 'home',
      name: 'Home server',
      baseUrl: 'https://emby.example'
    }), /invalid JSON/);
    assert.equal(await fs.readFile(fixture.filePath, 'utf8'), '{invalid');
  } finally {
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }
});
