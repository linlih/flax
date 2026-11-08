import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@paper/ui/tokens.css'
import './styles.css'
import { App } from './App'
import { isMac } from './lib/platform'

// macOS 左上角是红绿灯；其他平台右上角是系统的窗口按钮，左上角放一个菜单按钮
document.documentElement.classList.add(isMac ? 'os-mac' : 'os-other')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
