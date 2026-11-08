// 导入流程在 @flax/core（importer.ts），手机版也用。这里接上桌面的读文件（node:fs）、哈希（node:crypto）和 pdf.js。
import { readFile } from 'node:fs/promises'
import { Importer as CoreImporter, type ImporterDeps } from '@flax/core'
import { readPdfFacts } from './pdf'
import { sha256 } from './store'

type Platform = 'read' | 'hash' | 'pdfFacts'
export type DesktopImporterDeps = Omit<ImporterDeps, Platform> & Partial<Pick<ImporterDeps, Platform>>

export class Importer extends CoreImporter {
  constructor(d: DesktopImporterDeps) {
    super({ read: async (p) => new Uint8Array(await readFile(p)), hash: sha256, pdfFacts: readPdfFacts, ...d })
  }
}
