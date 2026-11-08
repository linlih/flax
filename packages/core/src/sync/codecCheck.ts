// 各平台的 Codec 必须和桌面（node:crypto + zlib）算出一样的结果，不然一台设备加密的同步库另一台打不开。
// 这里是一组固定的测试数据（用桌面的实现生成），每个平台的实现都跑一遍 checkCodec。
// 手机版可以在开发用的页面里跑，也可以写进它自己的测试。
import { fromBase64, fromUtf8, type Codec } from './codec'

const SALT = '00112233445566778899aabbccddeeff'

export const CODEC_VECTORS = {
  /** 十六进制 */
  salt: SALT,
  password: '同步密码 correct horse',
  /** PBKDF2-SHA256，600000 次（真实的次数），32 字节 */
  key600k: 'HoB254LzL3dJAxc0ih47rlEBTtLYEGqQ/gveDry/rNY=',
  /** 同一个密码 1000 次：测试里跑得快 */
  key1k: 'ecX5vknUFIxOWdpPSkN81BMw7oIxdeCVFgOokX83xqg=',
  /** 密码先做 NFC 规范化："café" 不管是一个 é 还是 e 加重音符，都得到这个（1000 次） */
  cafe1k: 'CXp/YG7edN5Z8AFDa8ld5Aa7c8Sinql4lqaG1p4XXHE=',
  plain: '{"v":1,"text":"Flax 同步"}',
  /** 用 key600k 加密 plain：IV(12) + 密文 + 校验(16) */
  sealed: 'AQIDBAUGBwgJCgsM1YTjeNUobbFv+ifU+Xon2aN/STBDzlDwqBzIhUhe9TiXfaAlVxMeESVXPa8=',
  /** zlib 压缩的 plain（gzip 格式，不同实现压出来的字节可以不一样，但都要能解开） */
  gz: 'H4sIAAAAAAAAE6tWKlOyMtRRKkmtKFGyUnLLSaxQeDqh59napUq1ABhjhJMcAAAA'
}

const hexBytes = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)))
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * 检查一个 Codec 和桌面兼容；不兼容时抛错，说明哪一项不对。
 * full：再跑一次真实的 600000 次派生（手机上可能要几秒）
 */
export async function checkCodec(codec: Codec, full = false): Promise<void> {
  const v = CODEC_VECTORS
  const salt = hexBytes(v.salt)
  const fail = (what: string) => {
    throw new Error(`Codec 和桌面不兼容：${what}`)
  }
  if (!same(await codec.deriveKey(v.password, salt, 1000), fromBase64(v.key1k))) fail('PBKDF2 派生的密钥不一样')
  if (!same(await codec.deriveKey('café', salt, 1000), fromBase64(v.cafe1k))) fail('密码没有先做 NFC 规范化')
  if (full && !same(await codec.deriveKey(v.password, salt, 600_000), fromBase64(v.key600k))) fail('600000 次派生的密钥不一样')
  const key = fromBase64(v.key600k)
  if (fromUtf8(await codec.decrypt(key, fromBase64(v.sealed))) !== v.plain) fail('解不开桌面加密的数据')
  const wrong = new Uint8Array(key)
  wrong[0] = wrong[0]! ^ 1
  let rejected = false
  try {
    await codec.decrypt(wrong, fromBase64(v.sealed))
  } catch {
    rejected = true
  }
  if (!rejected) fail('密钥不对时没有报错（没有校验 GCM 的 tag）')
  const mine = await codec.encrypt(key, new TextEncoder().encode(v.plain))
  if (mine.length !== fromBase64(v.sealed).length) fail('加密结果的长度不对（应该是 IV 12 字节 + 密文 + tag 16 字节）')
  if (fromUtf8(await codec.decrypt(key, mine)) !== v.plain) fail('解不开自己加密的数据')
  if (fromUtf8(await codec.gunzip(fromBase64(v.gz))) !== v.plain) fail('解不开桌面压缩的数据')
  if (fromUtf8(await codec.gunzip(await codec.gzip(new TextEncoder().encode(v.plain)))) !== v.plain) fail('解不开自己压缩的数据')
  const gz = await codec.gzip(new TextEncoder().encode(v.plain))
  if (gz[0] !== 0x1f || gz[1] !== 0x8b) fail('压缩结果不是 gzip 格式')
  if (codec.random(16).length !== 16) fail('随机数长度不对')
}
