import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
export async function readAtMost(path: string, max: number): Promise<{ content: string; truncated: boolean }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    if (!(await file.stat()).isFile()) throw new TypeError('Plugin configuration must be a regular file')
    const buffer = Buffer.alloc(max + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return { content: buffer.subarray(0, Math.min(offset, max)).toString('utf8'), truncated: offset > max }
  } finally {
    await file.close()
  }
}
