const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const EmbyApiClient = require('../integrations/emby-api-client');

const LINUX_SECURE_BACKENDS = new Set([
  'gnome_libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6'
]);

class EmbyConnectionStore {
  constructor({ filePath, safeStorage, platform = process.platform }) {
    if (!filePath || !safeStorage) throw new Error('Connection storage requires a path and OS secure storage.');
    this.filePath = filePath;
    this.safeStorage = safeStorage;
    this.platform = platform;
    this.ephemeralTokens = new Map();
  }

  storageStatus() {
    let backend = 'OS credential store';
    try {
      if (this.platform === 'linux') backend = this.safeStorage.getSelectedStorageBackend();
    } catch {
      backend = 'unknown';
    }

    let persistentCredentials = false;
    try {
      persistentCredentials = this.safeStorage.isEncryptionAvailable()
        && (this.platform !== 'linux' || LINUX_SECURE_BACKENDS.has(backend));
    } catch {
      persistentCredentials = false;
    }

    return { backend, persistentCredentials };
  }

  async list() {
    const data = await this.readData();
    const { persistentCredentials } = this.storageStatus();
    return data.connections.map(connection => ({
      id: connection.id,
      name: connection.name,
      baseUrl: connection.baseUrl,
      hasToken: Boolean(connection.tokenCiphertext || this.ephemeralTokens.has(connection.id)),
      tokenStorage: connection.tokenCiphertext ? 'persistent'
        : this.ephemeralTokens.has(connection.id) ? 'session' : null,
      persistentCredentials
    }));
  }

  async save({ id, name, baseUrl, token = '', clearToken = false } = {}) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) {
      throw new Error('The connection identifier is invalid.');
    }
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) {
      throw new Error('Enter a connection name (1-80 characters).');
    }
    const normalizedUrl = EmbyApiClient.normalizeBaseUrl(baseUrl).toString();
    if (typeof token !== 'string') throw new Error('The API key must be text.');

    const data = await this.readData();
    let connection = data.connections.find(item => item.id === id);
    if (!connection) {
      connection = { id, name: '', baseUrl: '', tokenCiphertext: null };
      data.connections.push(connection);
    }
    connection.name = name.trim();
    connection.baseUrl = normalizedUrl;
    let updateEphemeralToken = false;
    let ephemeralToken = null;

    if (clearToken) {
      connection.tokenCiphertext = null;
      updateEphemeralToken = true;
    }

    if (token.trim()) {
      const { persistentCredentials } = this.storageStatus();
      if (persistentCredentials) {
        connection.tokenCiphertext = this.safeStorage.encryptString(token).toString('base64');
        updateEphemeralToken = true;
      } else {
        connection.tokenCiphertext = null;
        ephemeralToken = token;
        updateEphemeralToken = true;
      }
    }

    await this.writeData(data);
    if (updateEphemeralToken) {
      if (ephemeralToken) this.ephemeralTokens.set(id, ephemeralToken);
      else this.ephemeralTokens.delete(id);
    }
    return this.list();
  }

  async remove(id) {
    const data = await this.readData();
    data.connections = data.connections.filter(connection => connection.id !== id);
    await this.writeData(data);
    this.ephemeralTokens.delete(id);
    return this.list();
  }

  async getForRequest(id) {
    const data = await this.readData();
    const connection = data.connections.find(item => item.id === id);
    if (!connection) throw new Error('Select a saved Emby connection.');

    let token = this.ephemeralTokens.get(id);
    if (connection.tokenCiphertext) {
      if (!this.storageStatus().persistentCredentials) {
        throw new Error('The saved API key cannot be decrypted because OS secure storage is unavailable.');
      }
      try {
        token = this.safeStorage.decryptString(Buffer.from(connection.tokenCiphertext, 'base64'));
      } catch {
        throw new Error('The saved API key could not be decrypted by this OS account. Clear it and save the key again.');
      }
    }
    if (!token) throw new Error('Save an API key for this connection before making authenticated Emby requests.');
    return { baseUrl: connection.baseUrl, token };
  }

  async readData() {
    let content;
    try {
      content = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, connections: [] };
      throw error;
    }

    let data;
    try {
      data = JSON.parse(content);
    } catch {
      throw new Error('The saved Emby connections file is invalid JSON; it was not overwritten.');
    }
    if (data?.version !== 1 || !Array.isArray(data.connections)
      || data.connections.some(connection => !connection || typeof connection.id !== 'string'
        || typeof connection.name !== 'string' || typeof connection.baseUrl !== 'string'
        || (connection.tokenCiphertext !== null && typeof connection.tokenCiphertext !== 'string'))) {
      throw new Error('The saved Emby connections file has an unsupported format; it was not overwritten.');
    }
    return data;
  }

  async writeData(data) {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporaryPath, this.filePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}

module.exports = EmbyConnectionStore;
