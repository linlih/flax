// AI 问答服务挪到了 @flax/core（ai/service.ts）。这里接上桌面的哈希，再把以前存成文件的对话读进数据库。
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { Conversations } from '@flax/core'
import { AiService as CoreAiService, type AiServiceDeps } from '@flax/core/ai/runtime'
import { nodeMtCrypto } from './mt'

export { titleFor } from '@flax/core'
export type { AppleEngine } from '@flax/core/ai/runtime'

export class AiService extends CoreAiService {
  constructor(d: Omit<AiServiceDeps, 'mtCrypto' | 'uuid'> & Partial<Pick<AiServiceDeps, 'mtCrypto' | 'uuid'>>) {
    super({ mtCrypto: nodeMtCrypto, uuid: randomUUID, ...d })
  }
}

/**
 * 0.1.4 及以前，对话按论文存在 ai/conversations/<论文 id>.json。读进数据库以后挪到 ai/conversations-imported/，
 * 不删（万一要找回来）。读到一半退出了也没关系：下次接着读，已经读进去的跳过。返回读了几个文件
 */
export function importConversationFiles(aiDir: string, conversations: Conversations): number {
  const dir = join(aiDir, 'conversations')
  if (!existsSync(dir)) return 0
  const done = join(aiDir, 'conversations-imported')
  let n = 0
  for (const name of readdirSync(dir)) {
    const m = /^([\w-]{1,80})\.json$/.exec(name)
    if (!m) continue
    try {
      conversations.importLegacy(m[1]!, JSON.parse(readFileSync(join(dir, name), 'utf8')))
    } catch (e) {
      // 坏掉的文件留在原地，不影响别的
      console.error('import conversation', name, e)
      continue
    }
    mkdirSync(done, { recursive: true })
    renameSync(join(dir, name), join(done, name))
    n++
  }
  return n
}
