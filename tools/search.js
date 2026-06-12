/**
 * 联网搜索工具
 * 从 ai-tools.js 移植，使用搜狗+必应双重搜索源
 */

import { toolRegistry } from './registry.js'

/**
 * 搜索网络（搜狗 → 必应降级）
 * @param {string} query - 搜索关键词
 * @param {number} count - 返回结果数量
 * @returns {Array<{title: string, url: string, snippet: string}>}
 */
async function searchBing(query, count = 5) {
    // 搜狗搜索
    const sogouUrl = `https://www.sogou.com/web?query=${encodeURIComponent(query)}`

    logger.info(`[AI-Plugin] 搜索关键词: "${query}"`)

    const res = await fetch(sogouUrl, {
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        signal: AbortSignal.timeout(15000),
        redirect: 'follow'
    })

    if (!res.ok) {
        const errText = await res.text().catch(() => '')
        logger.error(`[AI-Plugin] 搜狗返回非200: ${res.status}, body前200字: ${errText.slice(0, 200)}`)
        throw new Error(`搜索请求失败 [${res.status}]`)
    }

    const html = await res.text()
    logger.info(`[AI-Plugin] 搜狗返回HTML长度: ${html.length}`)

    let results = []

    // 解析搜索结果
    const itemRegex = /<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>([\s\S]*?)(?=<h3|<div class="(?:vrwrap|rb)"|$)/gi
    let match
    while ((match = itemRegex.exec(html)) !== null && results.length < count) {
        const url = match[1]
        const title = match[2].replace(/<[^>]*>/g, '').trim()
        const tailHtml = match[3]

        let snippet = ''
        const snippetMatch = tailHtml.match(/<p[^>]*class="[^"]*str_info[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
            tailHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
        if (snippetMatch) {
            snippet = snippetMatch[1].replace(/<[^>]*>/g, '').trim()
        }

        if (title && url && !url.startsWith('javascript:')) {
            results.push({ title, url, snippet: snippet || '无摘要' })
        }
    }

    // 备用解析
    if (results.length === 0) {
        const linkRegex = /<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
        let linkMatch
        while ((linkMatch = linkRegex.exec(html)) !== null && results.length < count) {
            const url = linkMatch[1]
            const title = linkMatch[2].replace(/<[^>]*>/g, '').trim()
            if (title && url && !url.startsWith('javascript:')) {
                results.push({ title, url, snippet: '无摘要' })
            }
        }
    }

    // 搜狗无结果 → 必应降级
    if (results.length === 0) {
        logger.info('[AI-Plugin] 搜狗无结果，降级到必应搜索')
        try {
            const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${count}`
            const bingRes = await fetch(bingUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                    'Accept-Language': 'zh-CN,zh;q=0.9',
                },
                signal: AbortSignal.timeout(15000),
                redirect: 'follow'
            })
            if (bingRes.ok) {
                const bingHtml = await bingRes.text()
                const bingRegex = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi
                let bingMatch
                while ((bingMatch = bingRegex.exec(bingHtml)) !== null && results.length < count) {
                    const itemHtml = bingMatch[1]
                    const titleMatch = itemHtml.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i)
                    if (!titleMatch) continue
                    const url = titleMatch[1]
                    const title = titleMatch[2].replace(/<[^>]*>/g, '').trim()
                    let snippet = ''
                    const snipMatch = itemHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
                    if (snipMatch) snippet = snipMatch[1].replace(/<[^>]*>/g, '').trim()
                    if (title && url && !url.startsWith('javascript:')) {
                        results.push({ title, url, snippet: snippet || '无摘要' })
                    }
                }
            }
        } catch (bingErr) {
            logger.warn('[AI-Plugin] 必应降级也失败:', bingErr)
        }
    }

    // 去重
    const seenUrls = new Set()
    results = results.filter(item => {
        if (seenUrls.has(item.url)) return false
        seenUrls.add(item.url)
        return true
    })

    logger.info(`[AI-Plugin] 搜索返回 ${results.length} 条结果`)
    return results
}

export const webSearchTool = {
    name: 'web_search',
    description: '联网搜索实时信息，获取最新数据和事实。当你需要查询最新的新闻、事件、数据或不确定的信息时使用。',

    functionSchema: {
        type: 'function',
        function: {
            name: 'web_search',
            description: '搜索互联网获取实时信息。当用户询问需要最新信息的问题时调用此函数。',
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
        const results = await searchBing(query, count)
        return results
    },

    formatResult(data) {
        if (!data || data.length === 0) {
            return '\n\n【网络搜索结果】未找到相关结果。'
        }
        let text = '\n\n【以下是从搜索引擎获取到的相关网络信息：】\n'
        data.forEach((item, i) => {
            text += `\n${i + 1}. ${item.title}\n   来源: ${item.url}\n   摘要: ${item.snippet}\n`
        })
        return text
    }
}

// 自动注册
toolRegistry.register(webSearchTool)