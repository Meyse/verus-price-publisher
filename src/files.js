// Atomic file write: temporary file in the same folder, fsync, rename.

import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function writeFileAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  const handle = await open(temp, 'w', 0o644);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
