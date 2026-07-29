/**
 * 联网搜索工具
 * 主搜索源：Bing + 百度并行；冗余补位：DuckDuckGo + Yahoo + 360；兜底降级：搜狗
 */

import { toolRegistry } from './registry.js'
import dns from 'node:dns/promises'
import net from 'node:net'
import sharp from 'sharp'
import { hasExplicitImageSearchIntent } from '../utils/tool_intent.js'

const SEARCH_TIMEOUT_MS = 15000
const IMAGE_DOWNLOAD_TIMEOUT_MS = 18000
const MAX_IMAGE_DOWNLOAD_BYTES = 10 * 1024 * 1024
const MAX_PREVIEW_PAGE_BYTES = 3 * 1024 * 1024
const MAX_IMAGE_SEND_COUNT = 3
const MAX_IMAGE_VERIFY_CANDIDATES = 6
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

function normalizeSearchText(text = '') {
    return decodeHtmlEntities(String(text || ''))
        .toLowerCase()
        .replace(/[^a-z0-9\u3400-\u9fff]+/g, '')
}

function extractQueryRelevanceProfile(query = '') {
    const value = decodeHtmlEntities(String(query || '')).toLowerCase()
    const modelAnchors = [...new Set((value.match(/[a-z]{1,12}[\s_-]*\d[a-z0-9\s_-]*/gi) || [])
        .map(normalizeSearchText)
        .filter(anchor => anchor.length >= 3))]
    const numberAnchors = [...new Set((value.match(/\d{2,}/g) || []).map(normalizeSearchText))]
    const chineseRuns = value.match(/[\u3400-\u9fff]{2,}/g) || []
    const semanticAnchors = [...new Set(chineseRuns
        .map(run => run.replace(/^(?:帮我|给我|请|搜索|搜|查|找|关于|有关|式|型)+/g, ''))
        .map(run => run.replace(/(?:的|图片|照片|资料|信息|介绍)$/g, ''))
        .filter(run => run.length >= 3))]
    return {
        modelAnchors,
        numberAnchors,
        semanticAnchors,
        strict: modelAnchors.length > 0
    }
}

export function scoreSearchResultRelevance(query, result = {}) {
    const profile = extractQueryRelevanceProfile(query)
    const title = normalizeSearchText(result.title)
    const snippet = normalizeSearchText(result.snippet)
    const url = normalizeSearchText(result.url || result.pageUrl)
    const imageUrl = normalizeSearchText(result.imageUrl || result.thumbnailUrl)
    const haystack = `${title} ${snippet} ${url} ${imageUrl}`
    let score = 0
    const matchedModels = profile.modelAnchors.filter(anchor => haystack.includes(anchor))
    const matchedNumbers = profile.numberAnchors.filter(anchor => haystack.includes(anchor))
    const matchedSemantics = profile.semanticAnchors.filter(anchor => haystack.includes(anchor))
    score += matchedModels.length * 12
    score += matchedNumbers.length * 2
    score += matchedSemantics.length * 6
    if (profile.semanticAnchors.some(anchor => title.includes(anchor))) score += 3
    const verified = !profile.strict
        || matchedModels.length > 0
        || (matchedSemantics.length > 0
            && profile.numberAnchors.length > 0
            && matchedNumbers.length === profile.numberAnchors.length)
    return {
        score,
        verified,
        strict: profile.strict,
        matchedModels,
        matchedNumbers,
        matchedSemantics
    }
}

export function filterRelevantSearchResults(query, results = []) {
    return results
        .map(result => {
            const relevance = scoreSearchResultRelevance(query, result)
            return {
                ...result,
                relevanceScore: relevance.score,
                relevanceVerified: relevance.verified
            }
        })
        .filter(result => result.relevanceVerified)
        .sort((left, right) => right.relevanceScore - left.relevanceScore)
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

function buildHighPrecisionImageQuery(query = '') {
    const profile = extractQueryRelevanceProfile(query)
    if (!profile.strict) return query
    const anchors = [
        ...profile.modelAnchors.map(anchor => `"${anchor}"`),
        ...profile.semanticAnchors.slice(0, 1).map(anchor => `"${anchor}"`)
    ]
    return anchors.length > 0 ? anchors.join(' ') : query
}

async function searchBingImages(query, count = 10) {
    const preciseQuery = buildHighPrecisionImageQuery(query)
    const url = `https://www.bing.com/images/search?q=${encodeURIComponent(preciseQuery)}&first=1&safeSearch=Strict&mkt=zh-CN&setlang=zh-hans`
    const html = await fetchSearchHtml(url, 'Bing 图片')
    const parsed = parseBingImageResults(html, Math.max(count * 3, 20))
    const results = filterRelevantSearchResults(query, parsed).slice(0, count)
    logger.info(`[AI-Plugin] Bing 图片搜索返回 ${parsed.length} 条候选，相关性过滤后 ${results.length} 条`)
    return results
}

function extractDuckDuckGoVqd(html = '') {
    return html.match(/vqd=['"]([^'"]+)/i)?.[1]
        || html.match(/vqd=([\d-]+)/i)?.[1]
        || html.match(/"vqd":"([^"]+)/i)?.[1]
        || ''
}

async function searchDuckDuckGoImages(query, count = 10) {
    const landingUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`
    const html = await fetchSearchHtml(landingUrl, 'DuckDuckGo 图片令牌')
    const vqd = extractDuckDuckGoVqd(html)
    if (!vqd) throw new Error('DuckDuckGo 图片搜索令牌提取失败')
    const response = await fetch(`https://duckduckgo.com/i.js?l=wt-wt&o=json&q=${encodeURIComponent(query)}&vqd=${encodeURIComponent(vqd)}&f=,,,`, {
        headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'application/json,text/javascript,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
            'Referer': 'https://duckduckgo.com/',
            'X-Requested-With': 'XMLHttpRequest'
        },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
    })
    if (!response.ok) throw new Error(`DuckDuckGo 图片 HTTP ${response.status}`)
    const data = await response.json()
    const parsed = Array.isArray(data?.results) ? data.results.map(item => ({
        title: cleanText(item.title || '搜索图片'),
        imageUrl: normalizeUrl(item.image || ''),
        thumbnailUrl: normalizeUrl(item.thumbnail || ''),
        pageUrl: normalizeUrl(item.url || ''),
        source: 'DuckDuckGo 图片'
    })).filter(item => /^https?:\/\//i.test(item.imageUrl || item.thumbnailUrl)) : []
    const results = filterRelevantSearchResults(query, parsed).slice(0, count)
    logger.info(`[AI-Plugin] DuckDuckGo 图片搜索返回 ${parsed.length} 条候选，相关性过滤后 ${results.length} 条`)
    return results
}

function isLikelyGenericPreview(url = '') {
    return /(?:logo|favicon|avatar|default|placeholder|og[-_]?card|share[-_]?image|site[-_]?icon)/i.test(String(url || ''))
}

export function extractPageImageUrls(html = '', pageUrl = '') {
    const urls = []
    const patterns = [
        /<meta[^>]+(?:property|name)=["'](?:og:image(?::url)?|twitter:image(?::src)?)["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
        /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image(?::url)?|twitter:image(?::src)?)["'][^>]*>/gi,
        /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["'][^>]*>/gi
    ]
    for (const pattern of patterns) {
        let match
        while ((match = pattern.exec(html)) !== null) {
            try {
                const url = new URL(decodeHtmlEntities(match[1]), pageUrl).toString()
                if (/^https?:\/\//i.test(url) && !urls.includes(url)) urls.push(url)
            } catch {
                // 忽略无效或无法解析的页面图片地址。
            }
        }
    }
    const specific = urls.filter(url => !isLikelyGenericPreview(url))
    return specific
}

async function fetchPagePreviewCandidates(result) {
    let currentUrl = String(result?.url || '').trim()
    if (!currentUrl) return []
    for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
        const parsed = await assertPublicImageUrl(currentUrl)
        const response = await fetch(parsed, {
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.7',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7'
            },
            signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
            redirect: 'manual'
        })
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location')
            if (!location) return []
            currentUrl = new URL(location, parsed).toString()
            continue
        }
        if (!response.ok) return []
        const contentType = String(response.headers.get('content-type') || '').toLowerCase()
        if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) return []
        const declaredSize = Number(response.headers.get('content-length') || 0)
        if (declaredSize > MAX_PREVIEW_PAGE_BYTES) return []
        if (!response.body) return []

        const chunks = []
        let total = 0
        const reader = response.body.getReader()
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            total += value.byteLength
            if (total > MAX_PREVIEW_PAGE_BYTES) {
                await reader.cancel().catch(() => {})
                return []
            }
            chunks.push(Buffer.from(value))
        }
        const html = Buffer.concat(chunks, total).toString('utf8')
        return extractPageImageUrls(html, currentUrl).slice(0, 4).map(imageUrl => ({
            title: result.title,
            imageUrl,
            thumbnailUrl: '',
            pageUrl: currentUrl,
            source: `${result.source || '网页'}页面图片`,
            relevanceScore: result.relevanceScore,
            relevanceVerified: result.relevanceVerified
        }))
    }
    return []
}

async function searchResultPageImages(results = [], count = 12) {
    const settled = await Promise.allSettled(results.slice(0, 8).map(fetchPagePreviewCandidates))
    const merged = []
    const seen = new Set()
    for (const item of settled) {
        if (item.status !== 'fulfilled') continue
        for (const candidate of item.value) {
            if (!candidate.imageUrl || seen.has(candidate.imageUrl)) continue
            seen.add(candidate.imageUrl)
            merged.push(candidate)
            if (merged.length >= count) return merged
        }
    }
    return merged
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

async function prepareImageCandidates(imageResults = [], requestedCount = 1) {
    const count = Math.max(0, Math.min(MAX_IMAGE_SEND_COUNT, Number(requestedCount) || 0))
    if (count === 0) return { prepared: [], failures: [] }
    const prepared = []
    const failures = []
    for (const item of imageResults) {
        if (prepared.length >= Math.min(MAX_IMAGE_VERIFY_CANDIDATES, Math.max(count * 3, count))) break
        let lastError = ''
        const candidates = [item.imageUrl, item.thumbnailUrl].filter(Boolean)
        for (const url of candidates) {
            try {
                const downloaded = await downloadImage(url, item.pageUrl || 'https://www.bing.com/images/')
                prepared.push({
                    buffer: downloaded.buffer,
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
    return { prepared, failures }
}

function parseVisionSelection(text = '', candidateCount = 0) {
    const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
    const objectMatch = raw.match(/\{[\s\S]*\}/)
    if (!objectMatch) return null
    try {
        const parsed = JSON.parse(objectMatch[0])
        if (!Array.isArray(parsed.relevant)) return null
        return [...new Set(parsed.relevant
            .map(Number)
            .filter(index => Number.isInteger(index) && index >= 1 && index <= candidateCount))]
    } catch {
        return null
    }
}

async function buildVisionPart(item) {
    try {
        const data = await sharp(item.buffer)
            .rotate()
            .resize({ width: 960, height: 960, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 78 })
            .toBuffer()
        return { inline_data: { mime_type: 'image/jpeg', data: data.toString('base64') } }
    } catch {
        return { inline_data: { mime_type: item.contentType, data: item.buffer.toString('base64') } }
    }
}

async function verifyImagesWithVision(client, query, prepared = []) {
    if (prepared.length === 0) return { selected: [], used: false, reason: 'no_candidates' }
    if (!client?.makeRequest) return { selected: [], used: false, reason: 'vision_unavailable' }
    try {
        const parts = []
        for (let index = 0; index < prepared.length; index++) {
            parts.push({ text: `候选图片 #${index + 1}；搜索标题：${prepared[index].title || '无'}；来源页：${prepared[index].pageUrl || '无'}` })
            parts.push(await buildVisionPart(prepared[index]))
        }
        parts.push({
            text: `用户要找的是「${query}」。请逐张查看图片实际画面，而不是只相信搜索标题。只选择画面主体明确与该对象相符的候选；地图、学校、软件页面、宣传海报、包装袋、Logo、无关武器或无法确认的图片一律拒绝。内容重复或近似重复的图片只保留一张。只输出严格 JSON：{"relevant":[1,2],"rejected":[{"index":3,"reason":"简短原因"}]}。`
        })
        const response = await client.makeRequest('chat', {
            contents: [{ role: 'user', parts }]
        }, 'flash', 1200)
        if (!response?.success) throw new Error(response?.error || '视觉模型调用失败')
        const selectedIndexes = parseVisionSelection(response.data, prepared.length)
        if (!selectedIndexes) throw new Error('视觉模型返回格式无法解析')
        logger.info(`[AI-Plugin] 搜图视觉复核完成: 候选=${prepared.length}, 通过=${selectedIndexes.length}`)
        return {
            selected: selectedIndexes.map(index => prepared[index - 1]),
            used: true,
            reason: selectedIndexes.length > 0 ? 'verified' : 'no_relevant_images'
        }
    } catch (err) {
        logger.warn(`[AI-Plugin] 搜图视觉复核失败，为避免错图本轮不发送: ${err.message}`)
        return { selected: [], used: false, reason: err.message }
    }
}

async function sendPreparedImages(event, prepared = [], requestedCount = 1) {
    const selected = prepared.slice(0, Math.max(0, Math.min(MAX_IMAGE_SEND_COUNT, Number(requestedCount) || 0)))
    if (!event || selected.length === 0) return []
    const segments = selected.map(item => createImageSegment(item.buffer))
    await event.reply(segments.length === 1 ? segments[0] : segments, true)
    return selected.map(({ buffer, ...item }) => item)
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
    const strictRelevance = extractQueryRelevanceProfile(query).strict
    const candidateCount = strictRelevance ? Math.min(20, Math.max(count * 3, 10)) : count

    const mainResults = await Promise.allSettled([
        searchBing(query, candidateCount),
        searchBaidu(query, candidateCount)
    ])

    const mainGroups = mainResults.map((result, index) => {
        const name = index === 0 ? 'Bing' : '百度'
        if (result.status === 'fulfilled') return result.value
        logger.warn(`[AI-Plugin] ${name} 搜索失败: ${result.reason?.message || result.reason}`)
        return []
    })

    let mergedCandidates = mergeSearchResults(mainGroups, candidateCount)
    let merged = filterRelevantSearchResults(query, mergedCandidates).slice(0, count)
    let fallbackGroups = []

    if (merged.length < count) {
        logger.info(`[AI-Plugin] 主搜索结果不足 (${merged.length}/${count})，启用冗余搜索源补位`)
        const fallbackResults = await Promise.allSettled([
            searchDuckDuckGo(query, candidateCount),
            searchYahoo(query, candidateCount),
            searchSo360(query, candidateCount)
        ])

        fallbackGroups = fallbackResults.map((result, index) => {
            const names = ['DuckDuckGo', 'Yahoo', '360搜索']
            if (result.status === 'fulfilled') return result.value
            logger.warn(`[AI-Plugin] ${names[index]} 冗余搜索失败: ${result.reason?.message || result.reason}`)
            return []
        })

        mergedCandidates = mergeSearchResults([...mainGroups, ...fallbackGroups], candidateCount)
        merged = filterRelevantSearchResults(query, mergedCandidates).slice(0, count)
    }

    if (merged.length < count) {
        logger.info(`[AI-Plugin] 搜索结果仍不足 (${merged.length}/${count})，使用搜狗兜底补位`)
        try {
            const sogouResults = await searchSogou(query, candidateCount)
            mergedCandidates = mergeSearchResults([...mainGroups, ...fallbackGroups, sogouResults], candidateCount)
            merged = filterRelevantSearchResults(query, mergedCandidates).slice(0, count)
        } catch (err) {
            logger.warn(`[AI-Plugin] 搜狗兜底搜索失败: ${err.message}`)
        }
    }

    logger.info(`[AI-Plugin] 搜索相关性过滤: 候选=${mergedCandidates.length}, 通过=${merged.length}, 严格模式=${strictRelevance}`)
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

        const expandedWebResults = await searchWeb(query, Math.max(count, 8))
        const webResults = expandedWebResults.slice(0, count)
        const pageImageResults = await searchResultPageImages(expandedWebResults, Math.max(8, imageCount * 4))
        let imageSearchResult = pageImageResults
        if (imageSearchResult.length < imageCount) {
            const duckDuckGoResults = await searchDuckDuckGoImages(query, Math.max(8, imageCount * 4)).catch(err => {
                logger.warn(`[AI-Plugin] DuckDuckGo 图片搜索失败: ${err.message}`)
                return []
            })
            const seen = new Set(imageSearchResult.map(item => item.imageUrl || item.thumbnailUrl))
            imageSearchResult = imageSearchResult.concat(duckDuckGoResults.filter(item => {
                const key = item.imageUrl || item.thumbnailUrl
                if (!key || seen.has(key)) return false
                seen.add(key)
                return true
            }))
        }
        if (imageSearchResult.length < imageCount) {
            const bingResults = await searchBingImages(query, Math.max(8, imageCount * 4)).catch(err => {
                logger.warn(`[AI-Plugin] Bing 图片搜索失败: ${err.message}`)
                return []
            })
            const seen = new Set(imageSearchResult.map(item => item.imageUrl || item.thumbnailUrl))
            imageSearchResult = imageSearchResult.concat(bingResults.filter(item => {
                const key = item.imageUrl || item.thumbnailUrl
                if (!key || seen.has(key)) return false
                seen.add(key)
                return true
            }))
        }
        imageSearchResult = filterRelevantSearchResults(query, imageSearchResult)
        const preparedResult = await prepareImageCandidates(imageSearchResult, imageCount)
        const visionResult = await verifyImagesWithVision(context.client, query, preparedResult.prepared)
        const sentImages = await sendPreparedImages(context.event, visionResult.selected, imageCount)
        return {
            query,
            results: webResults,
            imageResults: imageSearchResult.slice(0, 10),
            requestedImages: imageCount,
            sentImages,
            imageFailures: preparedResult.failures,
            relevanceVerified: imageSearchResult.length > 0,
            visionVerificationUsed: visionResult.used,
            visionVerificationReason: visionResult.reason,
            ok: webResults.length > 0 || sentImages.length > 0
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
            if (sentImages.length === 0) {
                const reason = data?.visionVerificationReason
                text += reason === 'no_relevant_images'
                    ? '视觉模型检查后没有确认任何候选与目标相符，因此没有发送，不能拿无关图片凑数。\n'
                    : '没有通过完整的相关性与视觉复核，因此没有发送图片；请如实说明，不能声称已经发图。\n'
            } else if (data?.visionVerificationUsed) {
                text += '以上图片均已由多模态模型检查实际画面并确认相关。\n'
            }
        }
        return text
    }
}

// 自动注册
toolRegistry.register(webSearchTool)
