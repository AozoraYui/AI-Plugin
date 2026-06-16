/**
 * 网页抓取工具
 * 允许 AI 访问指定 URL 并提取可读文本内容
 */

import { toolRegistry } from './registry.js'

const DEFAULT_MAX_CHARS = 8000
const REQUEST_TIMEOUT_MS = 15000
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB

/**
 * 简单 HTML → 纯文本转换
 * 去标签、解码实体、压缩空白
 */
function htmlToText(html) {
    let text = html

    // 移除不可见标签及其内容
    text = text.replace(/<(script|style|noscript|iframe|svg|head|nav|footer|header|aside|form|select|option|canvas)[\s>][\s\S]*?<\/\1>/gi, '')
    // 自闭合标签
    text = text.replace(/<(script|style|noscript|iframe|svg|head|nav|footer|header|aside)[\s>][^>]*\/>/gi, '')

    // 块级元素 → 换行
    text = text.replace(/<\/?(div|p|br|h[1-6]|li|tr|table|section|article|blockquote|pre|hr|dl|dt|dd|figure|figcaption|main|details|summary|fieldset|legend|address)[^>]*>/gi, '\n')
    // <br> 自闭合形式
    text = text.replace(/<br[^>]*>/gi, '\n')

    // 去除所有剩余标签
    text = text.replace(/<[^>]*>/g, '')

    // 解码 HTML 实体
    text = text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))

    // 压缩空白：连续换行 → 最多两个换行，空格/Tab → 单个空格
    text = text.replace(/\n{3,}/g, '\n\n')
    text = text.replace(/[ \t]+/g, ' ')
    // 清理行首尾空白
    text = text.split('\n').map(l => l.trim()).join('\n')
    // 去除首尾空行
    text = text.replace(/^\n+/, '').replace(/\n+$/, '')

    return text
}

/**
 * 抓取网页并提取文本
 * @param {string} url - 目标 URL
 * @param {number} maxChars - 最大返回字符数
 * @returns {Promise<string>}
 */
async function fetchWebPage(url, maxChars = DEFAULT_MAX_CHARS) {
    if (!url || typeof url !== 'string' || !url.trim()) {
        return '\n\n【网页抓取失败】未指定 URL。\n'
    }

    const targetUrl = url.trim()

    // 仅允许 http/https
    if (!/^https?:\/\//i.test(targetUrl)) {
        return `\n\n【网页抓取失败】不支持的协议，仅允许 http/https: ${targetUrl}\n`
    }

    logger.info(`[AI-Plugin] WebFetch: 开始抓取 ${targetUrl}`)

    let res
    try {
        res = await fetch(targetUrl, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5',
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            redirect: 'follow',
        })
    } catch (err) {
        logger.warn(`[AI-Plugin] WebFetch 请求失败: ${targetUrl} - ${err.message}`)
        return `\n\n【网页抓取失败】请求出错: ${err.message}\n`
    }

    if (!res.ok) {
        logger.warn(`[AI-Plugin] WebFetch 返回非200: ${targetUrl} - ${res.status}`)
        return `\n\n【网页抓取失败】HTTP ${res.status}\n`
    }

    // 检查 Content-Type，跳过非 HTML 响应
    const contentType = res.headers.get('content-type') || ''
    if (contentType.includes('application/') && !contentType.includes('html') && !contentType.includes('xml')) {
        // 如果是 JSON，尝试返回
        if (contentType.includes('json')) {
            try {
                const json = await res.text()
                const truncated = json.slice(0, maxChars)
                logger.info(`[AI-Plugin] WebFetch 成功(JSON): ${targetUrl} (${truncated.length} 字符)`)
                return `\n\n【网页内容「${targetUrl}」(JSON, ${truncated.length} 字符)】：\n${truncated}${json.length > maxChars ? '\n...(已截断)' : ''}\n`
            } catch {
                return `\n\n【网页抓取失败】无法解析 JSON 响应\n`
            }
        }
        return `\n\n【网页抓取失败】不支持的内容类型: ${contentType}（仅支持 HTML/JSON）\n`
    }

    // 读取响应体（限制大小）
    let html
    try {
        const bodyText = await res.text()
        if (bodyText.length > MAX_RESPONSE_SIZE) {
            html = bodyText.slice(0, MAX_RESPONSE_SIZE)
        } else {
            html = bodyText
        }
    } catch (err) {
        logger.warn(`[AI-Plugin] WebFetch 读取响应失败: ${targetUrl} - ${err.message}`)
        return `\n\n【网页抓取失败】读取响应出错: ${err.message}\n`
    }

    // 提取文本
    let text = htmlToText(html)

    // 截断
    const originalLen = text.length
    if (text.length > maxChars) {
        text = text.slice(0, maxChars) + '\n...(已截断)'
    }

    logger.info(`[AI-Plugin] WebFetch 成功: ${targetUrl} (${originalLen} 字符, 返回 ${text.length} 字符)`)

    return `\n\n【网页内容「${targetUrl}」(${originalLen} 字符)：】\n${text}\n【网页内容结束】\n`
}

export const webFetchTool = {
    name: 'web_fetch',
    description: '抓取指定网页 URL 并提取可读文本内容，用于获取网页详细信息。',

    functionSchema: {
        type: 'function',
        function: {
            name: 'web_fetch',
            description: '访问指定网页 URL，提取并返回页面中的可读文本内容。适合在搜索后进一步查看具体网页的详细信息。',
            parameters: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description: '要抓取的网页 URL（必须以 http:// 或 https:// 开头）'
                    },
                    max_chars: {
                        type: 'integer',
                        description: '最大返回字符数，默认 8000。网页较长时会自动截断。'
                    }
                },
                required: ['url']
            }
        }
    },

    async execute(args) {
        const content = await fetchWebPage(args.url, args.max_chars)
        return content
    },

    formatResult(data) {
        return data
    }
}

// 自动注册
toolRegistry.register(webFetchTool)