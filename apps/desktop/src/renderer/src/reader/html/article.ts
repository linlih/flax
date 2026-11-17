// 把 arXiv 网页版清理成只剩正文、可以放进阅读器的一棵 DOM：
// 不要脚本、表单、外部样式和外面的图；只留本机存的图（相对路径）和 data: 图；
// 链接只留页内跳转和 http(s)；id 加前缀，免得和应用里的元素撞上。桌面和手机的阅读器共用。

const DROP = 'script, style, link, meta, base, iframe, frame, frameset, object, embed, applet, form, input, button, textarea, select, option, noscript, template, dialog, audio, video, canvas, nav, header, footer, .ltx_page_logo, .ltx_page_footer, .ltx_TOC, .ltx_dates, .ltx_role_email'
const URL_ATTRS = new Set(['href', 'xlink:href', 'src', 'action', 'formaction', 'poster', 'background', 'srcset', 'data', 'ping'])
export const ID_PREFIX = 'fx-'

export interface Prepared {
  article: HTMLElement
  title: string
}

/** raw：存在本机的网页；base：它所在的文件夹地址（图片是相对它的路径） */
export function prepareArticle(raw: string, base: string): Prepared {
  const doc = new DOMParser().parseFromString(raw, 'text/html')
  const src = doc.querySelector('article.ltx_document') ?? doc.body
  src.querySelectorAll(DROP).forEach((el) => el.remove())
  const baseUrl = new URL(base, location.href)

  const walk = (el: Element) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase()
      const v = attr.value.trim()
      if (name.startsWith('on')) el.removeAttribute(attr.name)
      else if (name === 'id') el.setAttribute('id', ID_PREFIX + v)
      else if (name === 'style') {
        if (/url\s*\(|expression|@import|position\s*:\s*fixed/i.test(v)) el.removeAttribute(attr.name)
      } else if (URL_ATTRS.has(name)) {
        const tag = el.tagName.toLowerCase()
        if ((name === 'href' || name === 'xlink:href') && v.startsWith('#')) el.setAttribute(attr.name, `#${ID_PREFIX}${v.slice(1)}`)
        else if (name === 'href' && tag === 'a' && /^(https?|mailto):/i.test(v)) {
          el.setAttribute('target', '_blank')
          el.setAttribute('rel', 'noopener noreferrer')
        } else if (name === 'src' && tag === 'img' && /^data:image\//i.test(v)) {
          /* 内嵌的小图照留 */
        } else if (name === 'src' && tag === 'img' && /^img\/\d+\.\w+$/.test(v)) el.setAttribute('src', new URL(v, baseUrl).href)
        else if (tag === 'img' && name === 'src') {
          // 外面的图（多是 arXiv 的标志）不去加载
          el.remove()
          return
        } else el.removeAttribute(attr.name)
      }
    }
    for (const kid of [...el.children]) walk(kid)
  }
  walk(src)

  const article = document.createElement('article')
  article.className = 'flax-html-article'
  article.lang = 'en'
  for (const n of [...src.childNodes]) article.appendChild(document.importNode(n, true))
  const title = (article.querySelector('.ltx_title_document')?.textContent ?? '').replace(/\s+/g, ' ').trim()
  return { article, title }
}
