import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AiSettings } from './ai/settings'
import { createLocalCrypt } from './localCrypt'

// 代替钥匙串：旧格式就是 "v10" 加明文，数一数被问了几次
function keychain() {
  const k = {
    asked: 0,
    deny: false,
    encrypt: (t: string) => Buffer.from('v10' + t),
    decrypt: (b: Buffer) => {
      k.asked++
      if (k.deny) throw new Error('用户拒绝')
      return b.subarray(3).toString()
    }
  }
  return k
}

describe('local secret key (macOS)', () => {
  it('encrypts without the keychain, and makes one key file only the user can read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flax-crypt-'))
    const kc = keychain()
    const c = createLocalCrypt(join(dir, 'secret.key'), kc)
    const sealed = c.encrypt('sk-test-123')
    expect(sealed.toString()).not.toContain('sk-test-123')
    expect(c.decrypt(sealed)).toBe('sk-test-123')
    expect(c.refresh!(sealed)).toBeNull()
    expect(kc.asked).toBe(0)
    // 只在 macOS 上用；Windows 没有这种权限位
    if (process.platform !== 'win32') expect(statSync(join(dir, 'secret.key')).mode & 0o777).toBe(0o600)
    // 下次启动（新的对象）读同一把密钥
    expect(createLocalCrypt(join(dir, 'secret.key'), kc).decrypt(sealed)).toBe('sk-test-123')
    // 换了密钥（文件丢了）解不开，不会解出乱码
    expect(() => createLocalCrypt(join(dir, 'other.key'), kc).decrypt(sealed)).toThrow()
  })

  it('turns keychain-encrypted data into the new format once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flax-crypt-'))
    const kc = keychain()
    const c = createLocalCrypt(join(dir, 'secret.key'), kc)
    const fresh = c.refresh!(kc.encrypt('old-key'))!
    expect(kc.asked).toBe(1)
    expect(c.decrypt(fresh)).toBe('old-key')
    expect(kc.asked).toBe(1)
    kc.deny = true
    expect(() => c.refresh!(kc.encrypt('x'))).toThrow()
  })

  it('AI settings rewrite an old key file when it is read, and ask the keychain only that once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flax-ai-'))
    const kc = keychain()
    const c = createLocalCrypt(join(dir, 'secret.key'), kc)
    const s = new AiSettings(join(dir, 'ai'), c)
    // 旧版本写的、钥匙串加密的 Key 文件
    mkdirSync(join(dir, 'ai', 'keys'), { recursive: true })
    writeFileSync(join(dir, 'ai', 'keys', 'svc.bin'), kc.encrypt('old-secret'))
    expect(s.key('svc')).toBe('old-secret')
    expect(kc.asked).toBe(1)
    expect(readFileSync(join(dir, 'ai', 'keys', 'svc.bin')).subarray(0, 4).toString()).toBe('FXK1')
    expect(new AiSettings(join(dir, 'ai'), c).key('svc')).toBe('old-secret')
    expect(kc.asked).toBe(1)
  })
})
