/**
 * 联网搜索工具
 * 主搜索源：Bing + 百度并行；冗余补位：DuckDuckGo + Yahoo + 360；兜底降级：搜狗
 */

import { toolRegistry } from './registry.js'

const SEARCH_TIMEOUT_MS = 15000
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

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
    description: '联网搜索实时信息，使用 Bing + 百度双引擎搜索，DuckDuckGo/Yahoo/360 作为冗余补位，搜狗作为兜底源。适合查询最新新闻、事件、数据或不确定的信息。',

    functionSchema: {
        type: 'function',
        function: {
            name: 'web_search',
            description: '搜索互联网获取实时信息。默认使用 Bing + 百度双引擎，结果不足时使用 DuckDuckGo/Yahoo/360 补位，最后兜底搜狗。',
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
                    }
                },
                required: ['query']
            }
        }
    },

    async execute(args) {
        const query = args.query
        const count = Math.min(args.count || 5, 10)
        if (!query || !query.trim()) {
            throw new Error('搜索关键词不能为空')
        }
        return await searchWeb(query, count)
    },

    formatResult(data) {
        if (!data || data.length === 0) {
            return '\n\n【网络搜索结果】未找到相关结果。'
        }
        let text = '\n\n【以下是从搜索引擎获取到的相关网络信息：】\n'
        data.forEach((item, i) => {
            const source = item.source ? ` (${item.source})` : ''
            text += `\n${i + 1}. ${item.title}${source}\n   来源: ${item.url}\n   摘要: ${item.snippet}\n`
        })
        return text
    }
}

// 自动注册
toolRegistry.register(webSearchTool)
