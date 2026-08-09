import { readFile, stat } from 'node:fs/promises';
import { parseJsonNoDuplicateKeys } from './relayContracts.js';

const DEFAULT_MAX_BYTES = 1024 * 1024;

export class ConnectionPublicationSourceError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'ConnectionPublicationSourceError';
    this.code = code;
  }
}

/** Reads one complete, atomically replaceable official-shared connection snapshot. */
export class FileConnectionPublicationSource {
  constructor({
    filePath,
    maxBytes = DEFAULT_MAX_BYTES,
    read = readFile,
    inspect = stat,
  } = {}) {
    this.filePath = `${filePath ?? ''}`.trim();
    this.maxBytes = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
    this.readFile = read;
    this.stat = inspect;
  }

  async read() {
    if (!this.filePath) {
      throw new ConnectionPublicationSourceError(
        'CONNECTION_PUBLICATION_NOT_CONFIGURED',
        'A connection publication file is not configured.',
      );
    }

    let file;
    try {
      file = await this.stat(this.filePath);
    } catch (cause) {
      throw new ConnectionPublicationSourceError(
        'CONNECTION_PUBLICATION_UNAVAILABLE',
        'The connection publication file is unavailable.',
        { cause },
      );
    }
    if (!file.isFile()) {
      throw new ConnectionPublicationSourceError(
        'INVALID_CONNECTION_PUBLICATION_FILE',
        'The connection publication source is not a regular file.',
      );
    }
    if (file.size > this.maxBytes) {
      throw new ConnectionPublicationSourceError(
        'CONNECTION_PUBLICATION_TOO_LARGE',
        'The connection publication exceeds the configured size limit.',
      );
    }

    let contents;
    try {
      contents = await this.readFile(this.filePath);
    } catch (cause) {
      throw new ConnectionPublicationSourceError(
        'CONNECTION_PUBLICATION_UNAVAILABLE',
        'The connection publication file could not be read.',
        { cause },
      );
    }
    if (contents.byteLength > this.maxBytes) {
      throw new ConnectionPublicationSourceError(
        'CONNECTION_PUBLICATION_TOO_LARGE',
        'The connection publication exceeds the configured size limit.',
      );
    }

    let parsed;
    try {
      parsed = parseJsonNoDuplicateKeys(contents.toString('utf8'));
    } catch (cause) {
      throw new ConnectionPublicationSourceError(
        'INVALID_CONNECTION_PUBLICATION',
        'The connection publication contains invalid JSON.',
        { cause },
      );
    }
    if (!Array.isArray(parsed)) {
      throw new ConnectionPublicationSourceError(
        'INVALID_CONNECTION_PUBLICATION',
        'The connection publication must be a complete JSON array.',
      );
    }

    return parsed;
  }
}
