/**
 * 网页抓取工具
 * 允许 AI 访问指定 URL 并提取可读文本内容
 */

import { toolRegistry } from './registry.js'

const DEFAULT_MAX_CHARS = 16000
const REQUEST_TIMEOUT_MS = 30000
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024 // 10MB

/**
 * 将 GitHub 网页 URL 转换为 GitHub API 请求
 * 直接爬取 github.com 网页易触发 secondary rate limit（防爬，偶发 429）；
 * 改走 api.github.com 限额更高、返回干净 JSON，更稳定。
 * @returns {{apiUrl: string, kind: string}|null} 无法识别则返回 null（按普通网页抓取）
 */
function resolveGitHubApi(rawUrl) {
    let u
    try {
        u = new URL(rawUrl)
    } catch {
        return null
    }
    if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return null

    const parts = u.pathname.split('/').filter(Boolean)
    if (parts.length < 2) return null
    const [owner, repo, section, ...rest] = parts

    // owner/repo/commits/<branch> 或 owner/repo/commits
    if (section === 'commits') {
        const branch = rest[0] || u.searchParams.get('ref') || ''
        const q = branch ? `?sha=${encodeURIComponent(branch)}&per_page=100` : '?per_page=100'
        return { apiUrl: `https://api.github.com/repos/${owner}/${repo}/commits${q}`, kind: 'commits' }
    }
    // owner/repo/commit/<sha>
    if (section === 'commit' && rest[0]) {
        return { apiUrl: `https://api.github.com/repos/${owner}/${repo}/commits/${rest[0]}`, kind: 'commit' }
    }
    // owner/repo/releases
    if (section === 'releases') {
        return { apiUrl: `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`, kind: 'releases' }
    }
    // owner/repo/issues 或 pulls
    if (section === 'issues' || section === 'pulls') {
        return { apiUrl: `https://api.github.com/repos/${owner}/${repo}/${section}?per_page=100&state=all`, kind: section }
    }
    // owner/repo/blob/<branch>/<path...> → 取原始文件
    if (section === 'blob' && rest.length >= 2) {
        const branch = rest[0]
        const filePath = rest.slice(1).join('/')
        return { apiUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`, kind: 'raw' }
    }
    // owner/repo（仓库主页）
    if (!section) {
        return { apiUrl: `https://api.github.com/repos/${owner}/${repo}`, kind: 'repo' }
    }
    return null
}

/** 将 GitHub API 返回的 JSON 精简为可读文本，减少冗余 token */
function formatGitHubJson(kind, json) {
    try {
        const data = JSON.parse(json)
        if (kind === 'commits' && Array.isArray(data)) {
            return data.map(c => {
                const msg = (c.commit?.message || '').split('\n')[0]
                const author = c.commit?.author?.name || c.author?.login || '未知'
                const date = c.commit?.author?.date || ''
                const sha = (c.sha || '').slice(0, 7)
                return `- [${sha}] ${date} ${author}: ${msg}`
            }).join('\n')
        }
        if (kind === 'commit') {
            const msg = data.commit?.message || ''
            const author = data.commit?.author?.name || ''
            const date = data.commit?.author?.date || ''
            const files = (data.files || []).map(f => `  ${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`).join('\n')
            return `提交 ${(data.sha || '').slice(0, 7)} by ${author} @ ${date}\n${msg}\n变更文件:\n${files}`
        }
        if (kind === 'releases' && Array.isArray(data)) {
            return data.map(r => `- ${r.tag_name} ${r.name || ''} (${r.published_at || '未发布'})\n${(r.body || '').slice(0, 500)}`).join('\n\n')
        }
        if ((kind === 'issues' || kind === 'pulls') && Array.isArray(data)) {
            return data.map(i => `- #${i.number} [${i.state}] ${i.title} (by ${i.user?.login || '?'}, ${i.created_at || ''})`).join('\n')
        }
        if (kind === 'repo') {
            return `仓库: ${data.full_name}\n描述: ${data.description || '无'}\n语言: ${data.language || '未知'}\nStar: ${data.stargazers_count} | Fork: ${data.forks_count} | Issue: ${data.open_issues_count}\n默认分支: ${data.default_branch}\n更新于: ${data.pushed_at}\n主页: ${data.homepage || ''}`
        }
    } catch {
        // 解析失败则返回原始 JSON
    }
    return json
}

/**
 * 通过 GitHub API/raw 抓取，带 429 退避重试与可选 token
 * 列表类资源（commits/issues/pulls/releases）自动跟随 Link 头翻页，拉取全部数据
 */
async function fetchGitHubApi(gh, originalUrl, maxChars) {
    const isRaw = gh.kind === 'raw'
    const headers = {
        'User-Agent': 'AI-Plugin-WebFetch',
        'Accept': isRaw ? 'text/plain,*/*' : 'application/vnd.github+json',
    }
    if (!isRaw) headers['X-GitHub-Api-Version'] = '2022-11-28'
    // 可选：配置 GITHUB_TOKEN 环境变量可大幅提高速率上限（匿名 60 次/小时 → 5000 次/小时）
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
    if (token && !isRaw) headers['Authorization'] = `Bearer ${token}`

    // 单次请求（含限流退避重试）。成功返回 {body, res}；失败返回 {error}
    const requestOnce = async (url) => {
        const maxRetries = 2
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            let res
            try {
                res = await fetch(url, {
                    method: 'GET',
                    headers,
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                    redirect: 'follow',
                })
            } catch (err) {
                logger.warn(`[AI-Plugin] WebFetch GitHub API 请求失败: ${url} - ${err.message}`)
                return { error: `\n\n【网页抓取失败】GitHub 请求出错: ${err.message}\n` }
            }

            if (res.status === 429 || res.status === 403) {
                const retryAfter = Number(res.headers.get('retry-after'))
                const remaining = res.headers.get('x-ratelimit-remaining')
                const reset = Number(res.headers.get('x-ratelimit-reset'))
                const quotaExhausted = remaining === '0'
                if (!quotaExhausted && attempt < maxRetries) {
                    const waitMs = retryAfter > 0 ? Math.min(retryAfter * 1000, 8000) : (attempt + 1) * 2000
                    logger.warn(`[AI-Plugin] WebFetch GitHub API ${res.status}（剩余配额 ${remaining}），${waitMs}ms 后重试 (${attempt + 1}/${maxRetries})`)
                    await new Promise(r => setTimeout(r, waitMs))
                    continue
                }
                let resetHint = ''
                if (quotaExhausted && reset > 0) {
                    const mins = Math.max(Math.ceil((reset * 1000 - Date.now()) / 60000), 1)
                    resetHint = `约 ${mins} 分钟后恢复。`
                }
                logger.warn(`[AI-Plugin] WebFetch GitHub API ${res.status}（剩余配额 ${remaining}）: ${url}`)
                return { error: `\n\n【网页抓取失败】GitHub 触发频率限制（HTTP ${res.status}，剩余配额 ${remaining ?? '未知'}）。匿名访问每小时仅 60 次，${resetHint}如需更高配额（5000 次/小时），可在服务器配置 GITHUB_TOKEN 环境变量。\n` }
            }

            if (!res.ok) {
                logger.warn(`[AI-Plugin] WebFetch GitHub API 返回非200: ${url} - ${res.status}`)
                return { error: `\n\n【网页抓取失败】GitHub API HTTP ${res.status}\n` }
            }

            let body
            try {
                body = await res.text()
                if (body.length > MAX_RESPONSE_SIZE) body = body.slice(0, MAX_RESPONSE_SIZE)
            } catch (err) {
                return { error: `\n\n【网页抓取失败】读取 GitHub 响应出错: ${err.message}\n` }
            }
            return { body, res }
        }
    }

    // 列表类资源：跟随 Link 头翻页，累积全部条目
    const isPaginated = ['commits', 'issues', 'pulls', 'releases'].includes(gh.kind)

    if (isPaginated) {
        const MAX_PAGES = 30 // 上限保护：30 页 × 100 条 = 最多 3000 条，避免超大仓库爆 token
        const all = []
        let url = gh.apiUrl
        let pages = 0
        let truncatedByLimit = false
        while (url && pages < MAX_PAGES) {
            const r = await requestOnce(url)
            if (r.error) {
                // 已经拿到部分数据时，带着已有数据继续返回；完全没拿到才报错
                if (all.length === 0) return r.error
                truncatedByLimit = true
                break
            }
            try {
                const arr = JSON.parse(r.body)
                if (Array.isArray(arr)) all.push(...arr)
                else { all.push(arr); break }
            } catch {
                break
            }
            pages++
            // 解析 Link 头的 rel="next"
            const link = r.res.headers.get('link') || ''
            const m = link.match(/<([^>]+)>;\s*rel="next"/)
            url = m ? m[1] : null
            if (!url && pages >= MAX_PAGES) truncatedByLimit = true
        }
        if (url && pages >= MAX_PAGES) truncatedByLimit = true

        const text = formatGitHubJson(gh.kind, JSON.stringify(all))
        const originalLen = text.length
        let finalText = text.length > maxChars ? text.slice(0, maxChars) + '\n...(内容过长已截断)' : text
        const note = truncatedByLimit ? `（注意：数据量较大，已达抓取上限，可能未覆盖最早的记录）` : ''
        logger.info(`[AI-Plugin] WebFetch 成功(GitHub ${gh.kind}): ${originalUrl} 共 ${all.length} 条，${pages} 页 (${originalLen} 字符)`)
        return `\n\n【GitHub 内容「${originalUrl}」(${gh.kind}, 共 ${all.length} 条${note}, ${originalLen} 字符)】：\n${finalText}\n【GitHub 内容结束】\n`
    }

    // 非列表资源（repo/commit/raw）：单次请求
    const r = await requestOnce(gh.apiUrl)
    if (r.error) return r.error
    const text = isRaw ? r.body : formatGitHubJson(gh.kind, r.body)
    const originalLen = text.length
    const finalText = text.length > maxChars ? text.slice(0, maxChars) + '\n...(已截断)' : text
    logger.info(`[AI-Plugin] WebFetch 成功(GitHub ${gh.kind}): ${originalUrl} (${originalLen} 字符)`)
    return `\n\n【GitHub 内容「${originalUrl}」(${gh.kind}, ${originalLen} 字符)】：\n${finalText}\n【GitHub 内容结束】\n`
}

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

    // GitHub 网页易触发 secondary rate limit（429），自动改走 GitHub API/raw，更稳定且返回干净数据
    const gh = resolveGitHubApi(targetUrl)
    if (gh) {
        logger.info(`[AI-Plugin] WebFetch: GitHub 链接改走 API (${gh.kind}) -> ${gh.apiUrl}`)
        return await fetchGitHubApi(gh, targetUrl, maxChars)
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
        if (res.status === 429) {
            return `\n\n【网页抓取失败】HTTP 429：目标站点请求过于频繁（触发了频率限制）。请稍后再试，通常几分钟后即可恢复。\n`
        }
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
    permission: 'master',
    description: '抓取指定网页的文本内容，用于获取网页详细信息。',

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