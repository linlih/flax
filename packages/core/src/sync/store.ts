// 同步引擎和各种数据之间的接口：文献库（SQLite）、笔记（.md 文件）各实现一个。
import type { Hlc } from './hlc'
import type { SyncKind, SyncRecord } from './record'

export interface Outgoing {
  rec: SyncRecord
  /** 交回 sent() 用：发出去以后记录又改了的话，不能当成已经发过 */
  token: string
}

export interface SyncStore {
  readonly kinds: SyncKind[]
  /** 找出本机改过的记录，打上时间戳，放进待发送 */
  collect(hlc: Hlc): void
  /** 待发送的记录 */
  pending(): Outgoing[]
  /** 这些已经传上去了 */
  sent(items: Outgoing[]): void
  /** 合并别的设备的记录；返回本地真的变了的条数 */
  apply(recs: SyncRecord[], hlc: Hlc): number
  /** 全部记录（写快照用） */
  snapshot(): SyncRecord[]
  /** 换了一个同步的资料库：忘掉同步状态，所有记录下次都当成新的发出去 */
  reset(): void
}
