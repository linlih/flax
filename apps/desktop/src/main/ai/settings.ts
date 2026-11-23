// AI 设置的规则挪到了 @flax/core（ai/settings.ts）。桌面上存在资料文件夹的 ai/ 下：
// settings.json 是设置，keys/<id>.bin 是加密过的 Key（macOS 用本机密钥，见 localCrypt.ts；别的系统用 Electron safeStorage）。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AiSettings as CoreAiSettings, type SettingsStorage } from '@flax/core/ai/runtime'

export { validService } from '@flax/core/ai/runtime'

import type { Crypt } from '../localCrypt'

export type { Crypt }

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
    const store = fileSettingsStorage(dir)
    const read = store.readKey.bind(store)
    // 旧格式的 Key 读到时换成新格式写回去（只问这一次钥匙串）；解不开就当没有
    store.readKey = (id) => {
      const data = read(id)
      if (!data || !crypt.refresh) return data
      try {
        const fresh = crypt.refresh(Buffer.from(data))
        if (!fresh) return data
        store.writeKey(id, new Uint8Array(fresh))
        return new Uint8Array(fresh)
      } catch {
        return null
      }
    }
    super(store, {
      available: () => crypt.available(),
      encrypt: (t) => new Uint8Array(crypt.encrypt(t)),
      decrypt: (b) => crypt.decrypt(Buffer.from(b))
    })
  }
}
