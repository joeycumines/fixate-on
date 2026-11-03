import {
  lstat as fsLstat,
  mkdir as fsMkdir,
  rename as fsRename,
  unlink as fsUnlink,
} from 'node:fs/promises';

/**
 * Maximum state file size accepted by this plugin (16 MiB).
 * Prevents memory exhaustion when parsing corrupted or runaway workspace snapshots.
 */
export const MAX_STATE_FILE_BYTES = 16 * 1024 * 1024;

/**
 * Reads a state file under a byte limit, rejecting symlinks and non-regular files.
 * Returns the decoded UTF-8 string and a boolean flag indicating if the file exceeded maxBytes.
 */
export async function portableReadBounded(
  filePath: string,
  maxBytes: number = MAX_STATE_FILE_BYTES,
): Promise<{text: string; truncated: boolean}> {
  const {open} = await import('node:fs/promises');
  const info = await fsLstat(filePath).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`refusing to read non-regular file: ${filePath}`);
  }
  const handle = await open(filePath, 'r');
  try {
    // Sized from the open handle rather than pre-open lstat to avoid TOCTOU file growth races.
    const opened = await handle.stat();
    const buf = Buffer.alloc(Math.min(opened.size, maxBytes));
    const {bytesRead} = await handle.read(buf, 0, buf.length, 0);
    return {
      text: buf.subarray(0, bytesRead).toString('utf8'),
      truncated: opened.size > maxBytes,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Writes data safely by writing to a temporary sibling file first and atomically renaming
 * it into place. Validates that the target path is not a symlink to prevent symlink traversal attacks.
 */
export async function portableWriteFile(
  filePath: string,
  data: string,
  mode: 0o600 | 0o700 = 0o600,
): Promise<void> {
  const {dirname} = await import('node:path');
  const {open} = await import('node:fs/promises');
  const {randomUUID} = await import('node:crypto');
  const {constants} = await import('node:fs');

  await fsMkdir(dirname(filePath), {recursive: true, mode: 0o700});
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
  let installed = false;
  let ownsTemporary = false;
  let backupPath: string | null = null;

  try {
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      mode,
    );
    ownsTemporary = true;
    try {
      await handle.writeFile(data, 'utf8');
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      // Must close before replacement or cleanup so Windows can rename/remove the handle.
      await handle.close();
    }

    const existing = await fsLstat(filePath).catch(() => undefined);
    if (existing?.isSymbolicLink()) {
      throw new Error(`refusing to replace symlinked state file: ${filePath}`);
    }
    if (existing && !existing.isFile()) {
      throw new Error(
        `refusing to replace non-regular state file: ${filePath}`,
      );
    }

    // Attempt direct atomic rename (works on POSIX even if target exists).
    // On Windows, if destination exists, rename throws EPERM/EEXIST; fall back to staging backup.
    try {
      await fsRename(temporaryPath, filePath);
      installed = true;
    } catch (renameError) {
      if (!existing) throw renameError;
      backupPath = `${filePath}.bak-${randomUUID()}`;
      await fsRename(filePath, backupPath);
      try {
        await fsRename(temporaryPath, filePath);
        installed = true;
      } catch (fallbackError) {
        try {
          await fsRename(backupPath, filePath);
        } catch (restoreError) {
          throw new Error(
            `snapshot replacement failed and prior snapshot restore failed; prior snapshot preserved at ${backupPath}: ${
              restoreError instanceof Error
                ? restoreError.message
                : String(restoreError)
            }`,
            {cause: fallbackError},
          );
        }
        throw fallbackError;
      }
      await fsUnlink(backupPath).catch(() => {});
    }

    // Best-effort directory fsync for metadata durability on POSIX systems.
    try {
      const directory = await open(dirname(filePath), constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // Directory fsync is unsupported on some platforms (notably Windows).
    }
    installed = true;
  } finally {
    if (ownsTemporary && !installed) {
      await fsUnlink(temporaryPath).catch(() => {});
    }
  }
}

/**
 * Returns true if the path exists and is a regular file, rejecting symlinks.
 */
export async function portableFileExists(filePath: string): Promise<boolean> {
  try {
    const info = await fsLstat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

/**
 * Returns size of a regular file in bytes, or -1 if missing, non-regular, or a symlink.
 */
export async function portableFileSize(filePath: string): Promise<number> {
  try {
    const info = await fsLstat(filePath);
    return info.isFile() ? info.size : -1;
  } catch {
    return -1;
  }
}
