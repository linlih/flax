import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AiApi, LibraryApi, NotesApi, PaperApi, SyncApi } from '../shared/api'

// 渲染进程能用的能力都从这里暴露。不直接暴露 ipcRenderer。
const invoke = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(`library:${channel}`, ...args)
const listen = <T>(channel: string) => (cb: (payload: T) => void) => {
  const fn = (_: unknown, payload: T) => cb(payload)
  ipcRenderer.on(channel, fn)
  return () => void ipcRenderer.removeListener(channel, fn)
}

const library = {
  snapshot: invoke('snapshot'),
  importPaths: invoke('importPaths'),
  pickAndImport: invoke('pickAndImport'),
  importBibTeX: invoke('importBibTeX'),
  exportCitations: invoke('exportCitations'),
  addFromText: invoke('addFromText'),
  update: invoke('update'),
  remove: invoke('remove'),
  restore: invoke('restore'),
  retryLookup: invoke('retryLookup'),
  downloadPdf: invoke('downloadPdf'),
  searchCandidates: invoke('searchCandidates'),
  applyCandidate: invoke('applyCandidate'),
  resolveDuplicate: invoke('resolveDuplicate'),
  openFile: invoke('openFile'),
  markOpened: invoke('markOpened'),
  savePosition: invoke('savePosition'),
  positionElsewhere: invoke('positionElsewhere'),
  annotations: invoke('annotations'),
  annotation: invoke('annotation'),
  addAnnotation: invoke('addAnnotation'),
  updateAnnotation: invoke('updateAnnotation'),
  removeAnnotation: invoke('removeAnnotation'),
  restoreAnnotation: invoke('restoreAnnotation'),
  showInFinder: invoke('showInFinder'),
  fileMissing: invoke('fileMissing'),
  relink: invoke('relink'),
  createFolder: invoke('createFolder'),
  renameFolder: invoke('renameFolder'),
  removeFolder: invoke('removeFolder'),
  renameTag: invoke('renameTag'),
  setTagColor: invoke('setTagColor'),
  addTerm: invoke('addTerm'),
  updateTerm: invoke('updateTerm'),
  removeTerm: invoke('removeTerm'),
  restoreTerm: invoke('restoreTerm'),
  onChanged: listen<void>('library:changed'),
  onNotice: listen('library:notice')
} as unknown as LibraryApi

const call = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(`notes:${channel}`, ...args)
const notes = {
  list: call('list'),
  read: call('read'),
  create: call('create'),
  save: call('save'),
  rename: call('rename'),
  remove: call('remove'),
  showInFinder: call('showInFinder'),
  onChanged: listen<void>('notes:changed')
} as unknown as NotesApi

const ai = {
  status: () => ipcRenderer.invoke('ai:status'),
  saveService: (service, key) => ipcRenderer.invoke('ai:saveService', service, key),
  removeService: (id) => ipcRenderer.invoke('ai:removeService', id),
  models: (id, refresh) => ipcRenderer.invoke('ai:models', id, refresh),
  select: (sel) => ipcRenderer.invoke('ai:select', sel),
  setEffort: (e) => ipcRenderer.invoke('ai:setEffort', e),
  conversation: (paperId, id) => ipcRenderer.invoke('ai:conversation', paperId, id),
  conversations: (paperId) => ipcRenderer.invoke('ai:conversations', paperId),
  newConversation: (paperId) => ipcRenderer.invoke('ai:newConversation', paperId),
  openConversation: (paperId, id) => ipcRenderer.invoke('ai:openConversation', paperId, id),
  renameConversation: (paperId, id, title) => ipcRenderer.invoke('ai:renameConversation', paperId, id, title),
  deleteConversation: (paperId, id) => ipcRenderer.invoke('ai:deleteConversation', paperId, id),
  ask: (paperId, question, quote) => ipcRenderer.invoke('ai:ask', paperId, question, quote),
  translate: (text) => ipcRenderer.invoke('ai:translate', text),
  setTranslateEngine: (e) => ipcRenderer.invoke('ai:setTranslateEngine', e),
  saveTranslateAccount: (a, secret) => ipcRenderer.invoke('ai:saveTranslateAccount', a, secret),
  testTranslate: (e) => ipcRenderer.invoke('ai:testTranslate', e),
  checkAppleTranslate: () => ipcRenderer.invoke('ai:checkAppleTranslate'),
  openTranslateLanguages: () => ipcRenderer.invoke('ai:openTranslateLanguages'),
  cancel: (requestId) => ipcRenderer.invoke('ai:cancel', requestId),
  onEvent: listen('ai:event'),
  onStatus: listen('ai:status')
} as AiApi

const sync: SyncApi = {
  status: () => ipcRenderer.invoke('sync:status'),
  probe: (c) => ipcRenderer.invoke('sync:probe', c),
  connect: (c, password) => ipcRenderer.invoke('sync:connect', c, password),
  pickFolder: () => ipcRenderer.invoke('sync:pickFolder'),
  disconnect: () => ipcRenderer.invoke('sync:disconnect'),
  syncNow: () => ipcRenderer.invoke('sync:syncNow'),
  onStatus: listen('sync:status')
}

const api: PaperApi = {
  platform: process.platform,
  pathForFile: (file) => webUtils.getPathForFile(file),
  appearance: () => ipcRenderer.invoke('app:appearance'),
  setAppearance: (value) => ipcRenderer.invoke('app:setAppearance', value),
  info: () => ipcRenderer.invoke('app:info'),
  showData: () => ipcRenderer.invoke('app:showData'),
  popupMenu: (x: number, y: number) => ipcRenderer.invoke('app:popupMenu', x, y),
  backup: () => ipcRenderer.invoke('app:backup'),
  moveData: () => ipcRenderer.invoke('app:moveData'),
  restore: () => ipcRenderer.invoke('app:restore'),
  library,
  notes,
  ai,
  sync,
  update: {
    state: () => ipcRenderer.invoke('app:updateState'),
    check: () => ipcRenderer.invoke('app:checkUpdate'),
    install: () => ipcRenderer.invoke('app:installUpdate'),
    onState: listen('app:update')
  },
  onMenu: listen('app:menu')
}

contextBridge.exposeInMainWorld('api', api)
