import { statfs } from 'node:fs/promises'

// the filesystem holding path; /data is a Docker volume, so this is the disk Docker's data root sits on
export async function diskUsage(path: string): Promise<{ diskTotal: number; diskUsed: number }> {
  const s = await statfs(path)
  return { diskTotal: s.blocks * s.bsize, diskUsed: (s.blocks - s.bfree) * s.bsize }
}
