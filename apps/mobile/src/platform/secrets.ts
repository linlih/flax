// 密码和 Key：expo-secure-store（Android Keystore 加密）。
// core 的 Keychain 接口是"把文字加密成字节"——SecureStore 自己就加密，这里只做编码；
// SettingsStorage 把 Key 的字节存进 SecureStore，settings.json 存成普通文件。
import * as SecureStore from 'expo-secure-store'
import { File } from 'expo-file-system'
import { fromBase64, fromUtf8, toBase64, utf8 } from '@flax/core'
import type { Keychain, SettingsStorage } from '@flax/core/ai/runtime'
import { aiDir } from './paths'

const OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }

// SecureStore 的 key 只能是字母、数字、. - _
const slot = (name: string) => name.replace(/[^A-Za-z0-9._-]/g, '_')

export const secrets = {
  get: (name: string): string | null => SecureStore.getItem(slot(name), OPTS),
  set: (name: string, value: string) => SecureStore.setItem(slot(name), value, OPTS),
  remove: (name: string) => SecureStore.deleteItemAsync(slot(name), OPTS)
}

export const keychain: Keychain = {
  available: () => true,
  encrypt: (text) => utf8(text),
  decrypt: (data) => fromUtf8(data)
}

export const aiSettingsStorage: SettingsStorage = {
  read() {
    const f = new File(aiDir, 'settings.json')
    return f.exists ? f.textSync() : null
  },
  write(text) {
    const f = new File(aiDir, 'settings.json')
    if (!f.exists) f.create({ intermediates: true })
    f.writeSync(text)
  },
  readKey: (id) => {
    const v = secrets.get(`ai.key.${id}`)
    return v ? fromBase64(v) : null
  },
  writeKey: (id, data) => secrets.set(`ai.key.${id}`, toBase64(data)),
  removeKey: (id) => void secrets.remove(`ai.key.${id}`),
  hasKey: (id) => !!secrets.get(`ai.key.${id}`)
}
