/**
 * 联网搜索工具
 * 主搜索源：Bing + 百度并行；冗余补位：DuckDuckGo + Yahoo + 360；兜底降级：搜狗
 */

import { toolRegistry } from './registry.js'
import dns from 'node:dns/promises'
import net from 'node:net'
import { hasExplicitImageSearchIntent } from '../utils/tool_intent.js'

const SEARCH_TIMEOUT_MS = 15000
const IMAGE_DOWNLOAD_TIMEOUT_MS = 18000
const MAX_IMAGE_DOWNLOAD_BYTES = 10 * 1024 * 1024
const MAX_IMAGE_SEND_COUNT = 3
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

function decodeHtmlEntities(text = '') {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
}

function cleanText(html = '') {
    return decodeHtmlEntities(html)
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}

function normalizeUrl(url = '') {
    return decodeHtmlEntities(url.trim())
}

function isPrivateIpAddress(address = '') {
    const value = String(address || '').toLowerCase()
    if (net.isIPv4(value)) {
        const [a, b] = value.split('.').map(Number)
        return a === 10
            || a === 127
            || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168)
            || a === 0
    }
    if (net.isIPv6(value)) {
        return value === '::1'
            || value === '::'
            || /^f[cd][0-9a-f]*:/i.test(value)
            || /^fe80:/i.test(value)
    }
    return true
}

async function assertPublicImageUrl(rawUrl) {
    const url = new URL(rawUrl)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('图片地址不是 HTTP(S)')
    const hostname = url.hostname.toLowerCase()
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
        throw new Error('图片地址指向本地网络')
    }
    const literalType = net.isIP(hostname)
    if (literalType && isPrivateIpAddress(hostname)) throw new Error('图片地址指向私有 IP')
    if (!literalType) {
        const addresses = await dns.lookup(hostname, { all: true })
        if (addresses.length === 0 || addresses.some(item => isPrivateIpAddress(item.address))) {
            throw new Error('图片域名解析到私有地址')
        }
    }
    return url
}

function isValidResult(title, url) {
    return title && url && /^https?:\/\//i.test(url) && !url.startsWith('javascript:')
}

async function fetchSearchHtml(url, engineName) {
    const res = await fetch(url, {
        method: 'GET',
        headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
        },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
        redirect: 'follow'
    })

    if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`${engineName} HTTP ${res.status}: ${body.slice(0, 120)}`)
    }

    const html = await res.text()
    logger.info(`[AI-Plugin] ${engineName} 返回HTML长度: ${html.length}`)
    return html
}

async function searchBing(query, count) {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${count}`
    const html = await fetchSearchHtml(url, 'Bing')
    const results = []
    const itemRegex = /<li class="b_algo"[^>]*>([\s\S]*?)(?=<li class="b_algo"|<\/ol>|$)/gi
    let match

    while ((match = itemRegex.exec(html)) !== null && results.length < count) {
        const itemHtml = match[1]
        const titleMatch = itemHtml.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
        if (!titleMatch) continue

        const url = normalizeUrl(titleMatch[1])
        const title = cleanText(titleMatch[2])
        const snippetMatch = itemHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
        const snippet = snippetMatch ? cleanText(snippetMatch[1]) : '无摘要'

        if (isValidResult(title, url)) {
            results.push({ title, url, snippet, source: 'Bing' })
        }
    }

    logger.info(`[AI-Plugin] Bing 搜索返回 ${results.length} 条结果`)
    return results
}

export function parseBingImageResults(html = '', count = 10) {
    const results = []
    const seen = new Set()
    const itemRegex = /<a[^>]*class="[^"]*\biusc\b[^"]*"[^>]*\bm="([^"]+)"[^>]*>/gi
    let match

    while ((match = itemRegex.exec(html)) !== null && results.length < count) {
        try {
            const item = JSON.parse(decodeHtmlEntities(match[1]))
            const imageUrl = normalizeUrl(item.murl || '')
            const thumbnailUrl = normalizeUrl(item.turl || '')
            const pageUrl = normalizeUrl(item.purl || '')
            const key = imageUrl || thumbnailUrl
            if (!/^https?:\/\//i.test(key) || seen.has(key)) continue
            seen.add(key)
            results.push({
                title: cleanText(item.t || item.desc || '搜索图片'),
                imageUrl,
                thumbnailUrl,
                pageUrl,
                source: 'Bing 图片'
            })
        } catch {
            // 单条结果格式异常时跳过，不影响其余图片。
        }
    }
    return results
}

async function searchBingImages(query, count = 10) {
    const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&first=1&safeSearch=Strict&mkt=zh-CN&setlang=zh-hans`
    const html = await fetchSearchHtml(url, 'Bing 图片')
    const results = parseBingImageResults(html, count)
    logger.info(`[AI-Plugin] Bing 图片搜索返回 ${results.length} 条结果`)
    return results
}

async function readImageBuffer(response) {
    const declaredSize = Number(response.headers.get('content-length') || 0)
    if (declaredSize > MAX_IMAGE_DOWNLOAD_BYTES) throw new Error('图片超过大小限制')
    if (!response.body) throw new Error('图片响应没有正文')

    const chunks = []
    let total = 0
    const reader = response.body.getReader()
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_IMAGE_DOWNLOAD_BYTES) {
            await reader.cancel().catch(() => {})
            throw new Error('图片超过大小限制')
        }
        chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks, total)
}

async function downloadImage(url, referer = '') {
    let currentUrl = String(url || '').trim()
    for (let redirectCount = 0; redirectCount <= 4; redirectCount++) {
        const parsed = await assertPublicImageUrl(currentUrl)
        const response = await fetch(parsed, {
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'image/avif,image/webp,image/apng,image/png,image/jpeg,image/gif,*/*;q=0.8',
                ...(referer ? { Referer: referer } : {})
            },
            signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS),
            redirect: 'manual'
        })
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location')
            if (!location) throw new Error(`图片重定向缺少地址: HTTP ${response.status}`)
            currentUrl = new URL(location, parsed).toString()
            continue
        }
        if (!response.ok) throw new Error(`图片下载 HTTP ${response.status}`)
        const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
        if (!SUPPORTED_IMAGE_TYPES.has(contentType)) throw new Error(`不支持的图片类型: ${contentType || '未知'}`)
        const buffer = await readImageBuffer(response)
        if (buffer.length === 0) throw new Error('图片内容为空')
        return { buffer, contentType, finalUrl: currentUrl }
    }
    throw new Error('图片重定向次数过多')
}

function createImageSegment(buffer) {
    const file = `base64://${buffer.toString('base64')}`
    if (globalThis.segment?.image) return globalThis.segment.image(file)
    return { type: 'image', data: { file } }
}

async function sendSearchedImages(event, imageResults = [], requestedCount = 1) {
    const count = Math.max(0, Math.min(MAX_IMAGE_SEND_COUNT, Number(requestedCount) || 0))
    if (!event || count === 0) return { sent: [], failures: [] }

    const sent = []
    const failures = []
    for (const item of imageResults) {
        if (sent.length >= count) break
        let lastError = ''
        const candidates = [item.imageUrl, item.thumbnailUrl].filter(Boolean)
        for (const url of candidates) {
            try {
                const downloaded = await downloadImage(url, item.pageUrl || 'https://www.bing.com/images/')
                await event.reply(createImageSegment(downloaded.buffer), true)
                sent.push({
                    title: item.title,
                    pageUrl: item.pageUrl,
                    imageUrl: downloaded.finalUrl,
                    source: item.source,
                    sizeBytes: downloaded.buffer.length,
                    contentType: downloaded.contentType
                })
                lastError = ''
                break
            } catch (err) {
                lastError = err.message
            }
        }
        if (lastError) failures.push({ title: item.title, error: lastError })
    }
    return { sent, failures }
}

async function searchBaidu(query, count) {
    const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${count}`
    const html = await fetchSearchHtml(url, '百度')
    const results = []
    const itemRegex = /<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?=<h3|<div id="page"|$)/gi
    let match

    while ((match = itemRegex.exec(html)) !== null && results.length < count) {
        const url = normalizeUrl(match[1])
        const title = cleanText(match[2])
        const itemHtml = match[0]
        const snippetMatch = itemHtml.match(/<(?:span|div)[^>]*class="[^"]*(?:content-right|c-abstract|c-span-last|c-line-clamp)[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div)>/i)
        const snippet = snippetMatch ? cleanText(snippetMatch[1]) : cleanText(itemHtml).replace(title, '').slice(0, 180) || '无摘要'

        if (isValidResult(title, url)) {
            results.push({ title, url, snippet, source: '百度' })
        }
    }

    logger.info(`[AI-Plugin] 百度搜索返回 ${results.length} 条结果`)
    return results
}

async function searchDuckDuckGo(query, count) {
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    const html = await fetchSearchHtml(url, 'DuckDuckGo')
    const results = []
    const itemRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?=<a[^>]*class="[^"]*result__a|<\/body>|$)/gi
    let match

    while ((match = itemRegex.exec(html)) !== null && results.length < count) {
        let url = normalizeUrl(match[1])
        try {
            const parsed = new URL(url, 'https://duckduckgo.com')
            const uddg = parsed.searchParams.get('uddg')
            url = uddg ? decodeURIComponent(uddg) : parsed.href
        } catch { /* keep original url */ }

        const title = cleanText(match[2])
        const itemHtml = match[0]
        const snippetMatch = itemHtml.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ||
            itemHtml.match(/<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
        const snippet = snippetMatch ? cleanText(snippetMatch[1]) : '无摘要'

        if (isValidResult(title, url)) {
            results.push({ title, url, snippet, source: 'DuckDuckGo' })
        }
    }

    logger.info(`[AI-Plugin] DuckDuckGo 搜索返回 ${results.length} 条结果`)
    return results
}

async function searchYahoo(query, count) {
    const url = `https://search.yahoo.com/search?p=${encodeURIComponent(query)}`
    const html = await fetchSearchHtml(url, 'Yahoo')
    const results = []
    const itemRegex = /<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?=<h3|<\/ol>|$)/gi
    let match

    while ((match = itemRegex.exec(html)) !== null && results.length < count) {
        const url = normalizeUrl(match[1])
        const title = cleanText(match[2])
        const itemHtml = match[0]
        const snippetMatch = itemHtml.match(/<(?:p|div|span)[^>]*class="[^"]*(?:compText|fc-obsidian|lh-)[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div|span)>/i)
        const snippet = snippetMatch ? cleanText(snippetMatch[1]) : cleanText(itemHtml).replace(title, '').slice(0, 180) || '无摘要'

        if (isValidResult(title, url)) {
            results.push({ title, url, snippet, source: 'Yahoo' })
        }
    }

    logger.info(`[AI-Plugin] Yahoo 搜索返回 ${results.length} 条结果`)
    return results
}

async function searchSo360(query, count) {
    const url = `https://www.so.com/s?q=${encodeURIComponent(query)}`
    const html = await fetchSearchHtml(url, '360搜索')
    const results = []
    const itemRegex = /<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?=<h3|<\/body>|$)/gi
    let match

    while ((match = itemRegex.exec(html)) !== null && results.length < count) {
        const url = normalizeUrl(match[1])
        const title = cleanText(match[2])
        const itemHtml = match[0]
        const snippetMatch = itemHtml.match(/<(?:p|div)[^>]*class="[^"]*(?:res-desc|cont|js-res-desc|mh-summary)[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)>/i)
        const snippet = snippetMatch ? cleanText(snippetMatch[1]) : cleanText(itemHtml).replace(title, '').slice(0, 180) || '无摘要'

        if (isValidResult(title, url)) {
            results.push({ title, url, snippet, source: '360搜索' })
        }
    }

    logger.info(`[AI-Plugin] 360搜索返回 ${results.length} 条结果`)
    return results
}

async function searchSogou(query, count) {
    const url = `https://www.sogou.com/web?query=${encodeURIComponent(query)}`
    const html = await fetchSearchHtml(url, '搜狗')
    const results = []
    const itemRegex = /<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>([\s\S]*?)(?=<h3|<div class="(?:vrwrap|rb)"|$)/gi
    let match

    while ((match = itemRegex.exec(html)) !== null && results.length < count) {
        const url = normalizeUrl(match[1])
        const title = cleanText(match[2])
        const tailHtml = match[3]
        const snippetMatch = tailHtml.match(/<p[^>]*class="[^"]*str_info[^"]*"[^>]*>([\s\S]*?)<\/p>/i) || tailHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
        const snippet = snippetMatch ? cleanText(snippetMatch[1]) : '无摘要'

        if (isValidResult(title, url)) {
            results.push({ title, url, snippet, source: '搜狗' })
        }
    }

    logger.info(`[AI-Plugin] 搜狗搜索返回 ${results.length} 条结果`)
    return results
}

function mergeSearchResults(resultGroups, limit) {
    const merged = []
    const seen = new Set()
    const maxLen = Math.max(...resultGroups.map(group => group.length), 0)

    for (let i = 0; i < maxLen && merged.length < limit; i++) {
        for (const group of resultGroups) {
            const item = group[i]
            if (!item) continue
            const key = item.url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '')
            if (seen.has(key)) continue
            seen.add(key)
            merged.push(item)
            if (merged.length >= limit) break
        }
    }

    return merged
}

/**
 * 搜索网络：Bing + 百度并行主搜索，DuckDuckGo/Yahoo/360 补位，搜狗兜底
 * @param {string} query - 搜索关键词
 * @param {number} count - 返回结果数量
 * @returns {Array<{title: string, url: string, snippet: string, source: string}>}
 */
async function searchWeb(query, count = 5) {
    logger.info(`[AI-Plugin] 搜索关键词: "${query}"`)

    const mainResults = await Promise.allSettled([
        searchBing(query, count),
        searchBaidu(query, count)
    ])

    const mainGroups = mainResults.map((result, index) => {
        const name = index === 0 ? 'Bing' : '百度'
        if (result.status === 'fulfilled') return result.value
        logger.warn(`[AI-Plugin] ${name} 搜索失败: ${result.reason?.message || result.reason}`)
        return []
    })

    let merged = mergeSearchResults(mainGroups, count)
    let fallbackGroups = []

    if (merged.length < count) {
        logger.info(`[AI-Plugin] 主搜索结果不足 (${merged.length}/${count})，启用冗余搜索源补位`)
        const fallbackResults = await Promise.allSettled([
            searchDuckDuckGo(query, count),
            searchYahoo(query, count),
            searchSo360(query, count)
        ])

        fallbackGroups = fallbackResults.map((result, index) => {
            const names = ['DuckDuckGo', 'Yahoo', '360搜索']
            if (result.status === 'fulfilled') return result.value
            logger.warn(`[AI-Plugin] ${names[index]} 冗余搜索失败: ${result.reason?.message || result.reason}`)
            return []
        })

        merged = mergeSearchResults([...mainGroups, ...fallbackGroups], count)
    }

    if (merged.length < count) {
        logger.info(`[AI-Plugin] 搜索结果仍不足 (${merged.length}/${count})，使用搜狗兜底补位`)
        try {
            const sogouResults = await searchSogou(query, count)
            merged = mergeSearchResults([...mainGroups, ...fallbackGroups, sogouResults], count)
        } catch (err) {
            logger.warn(`[AI-Plugin] 搜狗兜底搜索失败: ${err.message}`)
        }
    }

    logger.info(`[AI-Plugin] 搜索最终返回 ${merged.length} 条结果`)
    return merged
}

export const webSearchTool = {
    name: 'web_search',
    permission: 'all',
    description: '联网搜索实时信息；用户明确要求图片时，还可搜索并直接发送最多 3 张相关图片。网页搜索使用多引擎冗余，图片搜索使用 Bing 严格安全搜索。',

    functionSchema: {
        type: 'function',
        function: {
            name: 'web_search',
            description: '搜索互联网获取实时信息。用户明确要求“带张图/有图片发我/搜图给我看”时设置 image_count；未明确要求图片时必须保持 0。',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: '搜索关键词，使用中文为佳'
                    },
                    count: {
                        type: 'integer',
                        description: '返回结果数量，默认5，最大10',
                        default: 5
                    },
                    image_count: {
                        type: 'integer',
                        description: '需要直接发送到当前 QQ 会话的相关图片数量。只有用户明确要求图片时填写 1-3；普通资料搜索必须为 0。',
                        default: 0
                    }
                },
                required: ['query']
            }
        }
    },

    async execute(args, context = {}) {
        const query = args.query
        const count = Math.min(args.count || 5, 10)
        const requestedImageCount = Math.max(0, Math.min(MAX_IMAGE_SEND_COUNT, Number(args.image_count) || 0))
        const currentInstruction = context.originalUserMessage || context.userMessage || ''
        const imageCount = requestedImageCount > 0 && hasExplicitImageSearchIntent(currentInstruction)
            ? requestedImageCount
            : 0
        if (requestedImageCount > 0 && imageCount === 0) {
            logger.warn('[AI-Plugin] web_search 已忽略未经用户明确要求的 image_count，降级为纯文本搜索')
        }
        if (!query || !query.trim()) {
            throw new Error('搜索关键词不能为空')
        }
        if (imageCount === 0) return await searchWeb(query, count)

        const [webResults, imageSearchResult] = await Promise.all([
            searchWeb(query, count),
            searchBingImages(query, Math.max(8, imageCount * 4)).catch(err => {
                logger.warn(`[AI-Plugin] 图片搜索失败: ${err.message}`)
                return []
            })
        ])
        const delivery = await sendSearchedImages(context.event, imageSearchResult, imageCount)
        return {
            query,
            results: webResults,
            imageResults: imageSearchResult.slice(0, 10),
            requestedImages: imageCount,
            sentImages: delivery.sent,
            imageFailures: delivery.failures,
            ok: webResults.length > 0 || delivery.sent.length > 0
        }
    },

    formatResult(data) {
        const results = Array.isArray(data) ? data : (Array.isArray(data?.results) ? data.results : [])
        const requestedImages = Array.isArray(data) ? 0 : Number(data?.requestedImages || 0)
        const sentImages = Array.isArray(data?.sentImages) ? data.sentImages : []
        if (results.length === 0 && requestedImages === 0) {
            return '\n\n【网络搜索结果】未找到相关结果。'
        }
        let text = '\n\n【以下是从搜索引擎获取到的相关网络信息：】\n'
        results.forEach((item, i) => {
            const source = item.source ? ` (${item.source})` : ''
            text += `\n${i + 1}. ${item.title}${source}\n   来源: ${item.url}\n   摘要: ${item.snippet}\n`
        })
        if (requestedImages > 0) {
            text += `\n【图片搜索与发送】用户要求 ${requestedImages} 张，实际已发送 ${sentImages.length} 张。\n`
            sentImages.forEach((item, index) => {
                text += `${index + 1}. ${item.title || '相关图片'}${item.pageUrl ? `；来源页面: ${item.pageUrl}` : ''}\n`
            })
            if (sentImages.length === 0) text += '没有成功下载并发送可用图片，请如实说明图片发送失败。\n'
        }
        return text
    }
}

// 自动注册
toolRegistry.register(webSearchTool)
