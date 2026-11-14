// 混合逻辑时钟（HLC）：物理时间 + 计数器 + 设备 ID，拼成可以直接按字符串比较大小的时间戳。
// 电脑时间不准时，收到过更晚的时间戳以后，本机的新修改也一定排在它后面。

/** 例：0001731100000000-0003-<deviceId>。前 16 位毫秒、4 位计数器，按字符串比较就是按时间比较 */
export type HlcStamp = string

export class Hlc {
  private ms = 0
  private n = 0

  constructor(readonly deviceId: string, last: HlcStamp | null = null, private clock: () => number = () => Date.now()) {
    if (last) this.observe(last)
  }

  /** 新的本机时间戳；at 是修改发生的时间（毫秒），不给就用现在 */
  tick(at?: number): HlcStamp {
    const now = at ?? this.clock()
    if (now > this.ms) {
      this.ms = now
      this.n = 0
    } else if (++this.n > 9999) {
      // 计数器只有 4 位（多一位，按字符串比大小就不对了）：用完了就把时间往后拨 1 毫秒
      this.ms++
      this.n = 0
    }
    return stamp(this.ms, this.n, this.deviceId)
  }

  /** 收到别的设备的时间戳：以后本机的时间戳都比它晚 */
  observe(s: HlcStamp): void {
    const p = parse(s)
    if (!p) return
    if (p.ms > this.ms || (p.ms === this.ms && p.n > this.n)) {
      this.ms = p.ms
      this.n = p.n
    }
  }

  /** 存盘用：下次启动从这里接着走 */
  last(): HlcStamp {
    return stamp(this.ms, this.n, this.deviceId)
  }
}

function stamp(ms: number, n: number, dev: string): HlcStamp {
  return `${String(ms).padStart(16, '0')}-${String(n).padStart(4, '0')}-${dev}`
}

function parse(s: string): { ms: number; n: number } | null {
  const m = /^(\d{16})-(\d{4,})-/.exec(s)
  return m ? { ms: Number(m[1]), n: Number(m[2]) } : null
}

/** ISO 时间转成毫秒；读不懂就是 0 */
export function isoMs(iso: string | undefined): number {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : 0
}
