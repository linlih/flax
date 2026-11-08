// AI 设置的规则挪到了 @flax/core（ai/settings.ts）。桌面上存在资料文件夹的 ai/ 下：
// settings.json 是设置，keys/<id>.bin 是用系统钥匙串（Electron safeStorage）加密过的 Key。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AiSettings as CoreAiSettings, type SettingsStorage } from '@flax/core/ai/runtime'

export { validService } from '@flax/core/ai/runtime'

export interface Crypt {
  available(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}

export function fileSettingsStorage(dir: string): SettingsStorage {
  const file = join(dir, 'settings.json')
  const keyDir = join(dir, 'keys')
  const keyPath = (id: string) => join(keyDir, `${id}.bin`)
  return {
    read() {
      try {
        return readFileSync(file, 'utf8')
      } catch {
        return null
      }
    },
    write(text) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, text)
    },
    readKey(id) {
      try {
        return new Uint8Array(readFileSync(keyPath(id)))
      } catch {
        return null
      }
    },
    writeKey(id, data) {
      mkdirSync(keyDir, { recursive: true })
      writeFileSync(keyPath(id), data, { mode: 0o600 })
    },
    removeKey(id) {
      rmSync(keyPath(id), { force: true })
    },
    hasKey: (id) => existsSync(keyPath(id)),
    adoptLegacyKey(id) {
      mkdirSync(keyDir, { recursive: true })
      if (existsSync(join(dir, 'key.bin'))) renameSync(join(dir, 'key.bin'), keyPath(id))
    }
  }
}

export class AiSettings extends CoreAiSettings {
  constructor(dir: string, crypt: Crypt) {
    super(fileSettingsStorage(dir), {
      available: () => crypt.available(),
      encrypt: (t) => new Uint8Array(crypt.encrypt(t)),
      decrypt: (b) => crypt.decrypt(Buffer.from(b))
    })
  }
}
