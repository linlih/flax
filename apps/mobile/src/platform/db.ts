// expo-sqlite 的同步接口 → core 的 SqlDb（和 node:sqlite 的 DatabaseSync 一个形状）。
import { openDatabaseSync, type SQLiteBindValue, type SQLiteDatabase } from 'expo-sqlite'
import type { SqlDb, SqlValue } from '@flax/core'
import { libraryDir, plainPath } from './paths'

export function expoDb(db: SQLiteDatabase): SqlDb {
  return {
    exec: (sql) => db.execSync(sql),
    prepare: (sql) => ({
      // 返回 { changes, lastInsertRowId }：笔记同步用到 changes，字段名和 node:sqlite 一样
      run: (...p: SqlValue[]) => db.runSync(sql, p as SQLiteBindValue[]),
      // 查不到时 expo 返回 null，node:sqlite 返回 undefined
      get: (...p: SqlValue[]) => db.getFirstSync(sql, p as SQLiteBindValue[]) ?? undefined,
      all: (...p: SqlValue[]) => db.getAllSync(sql, p as SQLiteBindValue[])
    })
  }
}

let raw: SQLiteDatabase | null = null

export function openLibraryDb(): SqlDb {
  raw ??= openDatabaseSync('library.sqlite', {}, plainPath(libraryDir.uri))
  raw.execSync('PRAGMA journal_mode = WAL')
  return expoDb(raw)
}
