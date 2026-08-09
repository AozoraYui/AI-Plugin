const SEARCH_REDIRECT_RULES = [
    ['baidu.com', /^\/link/i],
    ['so.com', /^\/link/i],
    ['sogou.com', /^\/link/i],
    ['bing.com', /^\/ck\/a/i],
    ['google.com', /^\/url/i]
]

const SEARCH_PAGE_RULES = [
    ['baidu.com', /^\/s(?:\/|$)/i],
    ['bing.com', /^\/search/i],
    ['so.com', /^\/s(?:\/|$)/i],
    ['image.so.com', /^\/i/i],
    ['sogou.com', /^\/web/i],
    ['google.com', /^\/search/i]
]

const ERROR_PAGE_PATTERNS = [
    /waerrpage/i,
    /(?:^|\/)(?:404|403|500|error|errors|upgrade|captcha|verify|challenge)(?:\/|$|[?._-])/i
]

const ERROR_CONTENT_PATTERNS = [
    /(?:页面不存在|内容不存在|访问异常|访问过于频繁|请完成验证|安全验证|验证码|升级后访问|系统繁忙|请求错误|禁止访问|access denied|page not found|just a moment|enable javascript and cookies)/i,
    /(?:waerrpage|error[_ -]?page|captcha|challenge-platform)/i
]

function normalizeHost(hostname = '') {
    return String(hostname || '').toLowerCase().replace(/^www\./, '')
}

function safeUrl(rawUrl = '') {
    try {
        return new URL(String(rawUrl || '').trim())
    } catch {
        return null
    }
}

function matchesRule(url, rules) {
    const host = normalizeHost(url?.hostname)
    const path = url?.pathname || '/'
    return rules.some(([domain, pattern]) => (host === domain || host.endsWith(`.${domain}`)) && pattern.test(path))
}

function compactText(value = '') {
    return String(value || '')
        .replace(/【网页[^】]*】/g, ' ')
        .replace(/【网页内容结束】/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

function stableUrlKey(rawUrl = '') {
    const url = safeUrl(rawUrl)
    if (!url) return ''
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
        if (/^(?:utm_.+|from|source|spm|ref|refer|tracking|share|share_source)$/i.test(key)) {
            url.searchParams.delete(key)
        }
    }
    url.hostname = normalizeHost(url.hostname)
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString()
}

export function classifyWebUrl(rawUrl = '') {
    const url = safeUrl(rawUrl)
    if (!url || !['http:', 'https:'].includes(url.protocol)) {
        return {
            category: 'invalid',
            domain: '',
            direct: false,
            autoFetchEligible: false,
            reason: 'URL 无效或不是 HTTP(S)'
        }
    }
    const domain = normalizeHost(url.hostname)
    if (ERROR_PAGE_PATTERNS.some(pattern => pattern.test(`${url.pathname}${url.search}`))) {
        return { category: 'error_page', domain, direct: false, autoFetchEligible: false, reason: 'URL 指向已知错误或验证页面' }
    }
    if (matchesRule(url, SEARCH_REDIRECT_RULES)) {
        return { category: 'search_redirect', domain, direct: false, autoFetchEligible: false, reason: '搜索引擎中转链接，不是原始来源' }
    }
    if (matchesRule(url, SEARCH_PAGE_RULES)) {
        return { category: 'search_page', domain, direct: false, autoFetchEligible: false, reason: '搜索或图片结果页，不是正文来源' }
    }
    return { category: 'direct', domain, direct: true, autoFetchEligible: true, reason: '直接网页来源' }
}

export function assessSearchResults(results = []) {
    const enriched = (Array.isArray(results) ? results : []).map(item => {
        const urlInfo = classifyWebUrl(item?.url || item?.pageUrl || '')
        const snippet = compactText(item?.snippet || '')
        const title = compactText(item?.title || '')
        const hasUsefulSnippet = snippet.length >= 24
        const usableEvidence = urlInfo.direct && hasUsefulSnippet
        const evidenceKey = usableEvidence ? stableUrlKey(item?.url || item?.pageUrl || '') : ''
        return {
            ...item,
            domain: urlInfo.domain,
            sourceCategory: urlInfo.category,
            directSource: urlInfo.direct,
            autoFetchEligible: urlInfo.autoFetchEligible,
            usableEvidence,
            qualityReason: usableEvidence ? '直接来源且搜索摘要包含有效文本' : (urlInfo.reason || '摘要过短'),
            evidenceKey
        }
    })
    const usable = enriched.filter(item => item.usableEvidence)
    const independentDomains = [...new Set(usable.map(item => item.domain).filter(Boolean))]
    const evidenceKeys = [...new Set(usable.map(item => item.evidenceKey).filter(Boolean))]
    const quality = independentDomains.length >= 3 && evidenceKeys.length >= 3
        ? 'high'
        : (independentDomains.length >= 2 && evidenceKeys.length >= 2 ? 'medium' : 'low')
    const autoFetchCandidate = enriched.find(item => item.autoFetchEligible && item.usableEvidence) || null
    return {
        results: enriched,
        quality,
        usableEvidenceCount: usable.length,
        independentSourceCount: independentDomains.length,
        independentDomains,
        evidenceKeys,
        autoFetchCandidate,
        // 搜索摘要只能用于发现来源，不能单独支撑人物/组织争议等敏感结论。
        sufficientForSensitiveClaims: false
    }
}

export function assessFetchedContent(requestedUrl = '', content = '') {
    const raw = String(content || '')
    const finalUrlMatches = [...raw.matchAll(/(?:最终地址|跳转目标)[：:]\s*(https?:\/\/[^\s]+)/gi)]
    const effectiveUrl = finalUrlMatches.length > 0
        ? finalUrlMatches[finalUrlMatches.length - 1][1].replace(/[）)】\],，。；;]+$/, '')
        : requestedUrl
    const requestedUrlInfo = classifyWebUrl(requestedUrl)
    const effectiveUrlInfo = classifyWebUrl(effectiveUrl)
    const urlInfo = effectiveUrl !== requestedUrl && effectiveUrlInfo.direct ? effectiveUrlInfo : requestedUrlInfo
    const text = compactText(raw)
    const explicitFailure = /^【[^】]+失败】/.test(text) || /【网页抓取失败】/.test(raw)
    const errorContent = ERROR_CONTENT_PATTERNS.some(pattern => pattern.test(text))
    const isJson = /\(JSON,\s*\d+\s*字符\)/i.test(raw)
    let usableEvidence = true
    let quality = 'high'
    let reason = '已提取直接网页正文'

    if (explicitFailure) {
        usableEvidence = false
        quality = 'none'
        reason = '网页抓取明确失败'
    } else if (!urlInfo.direct) {
        usableEvidence = false
        quality = 'none'
        reason = urlInfo.reason
    } else if (errorContent) {
        usableEvidence = false
        quality = 'none'
        reason = '页面正文疑似错误、验证或升级提示'
    } else if (text.length < (isJson ? 40 : 180)) {
        usableEvidence = false
        quality = 'low'
        reason = `正文过短（${text.length} 字），不足以作为可靠证据`
    } else if (text.length < 600) {
        quality = 'medium'
        reason = `正文较短（${text.length} 字），只能作为有限证据`
    }

    const evidenceKey = usableEvidence ? stableUrlKey(requestedUrl) : ''
    return {
        ok: usableEvidence,
        recoverable: !usableEvidence,
        summary: usableEvidence ? `网页正文可用，证据质量=${quality}` : `网页内容不可作为可靠证据：${reason}`,
        content: raw,
        quality,
        usableEvidence,
        reason,
        requestedUrl,
        effectiveUrl,
        domain: urlInfo.domain,
        sourceCategory: urlInfo.category,
        contentChars: text.length,
        evidenceKey,
        facts: {
            requestedUrl,
            effectiveUrl,
            domain: urlInfo.domain,
            sourceCategory: urlInfo.category,
            quality,
            usableEvidence,
            contentChars: text.length,
            reason,
            evidenceKey
        },
        next_hints: usableEvidence ? [] : ['换用原始页面、直接来源或其他独立来源，不要把当前页面内容当作已核实事实。']
    }
}

export function updateWebEvidenceState(state = {}, toolName = '', data = {}) {
    const current = {
        evidenceKeys: [...new Set(state.evidenceKeys || [])],
        fetchedEvidenceKeys: [...new Set(state.fetchedEvidenceKeys || [])],
        domains: [...new Set(state.domains || [])],
        usableFetchCount: Math.max(0, Number(state.usableFetchCount) || 0),
        lowQualityCount: Math.max(0, Number(state.lowQualityCount) || 0),
        searchCount: Math.max(0, Number(state.searchCount) || 0),
        fetchCount: Math.max(0, Number(state.fetchCount) || 0)
    }
    const keys = new Set(current.evidenceKeys)
    const fetchedKeys = new Set(current.fetchedEvidenceKeys)
    const domains = new Set(current.domains)
    if (toolName === 'web_search') {
        current.searchCount++
        for (const key of data?.evidenceKeys || []) if (key) keys.add(String(key))
        for (const domain of data?.independentDomains || []) if (domain) domains.add(String(domain))
        if (!data?.usableEvidenceCount) current.lowQualityCount++
    }
    if (toolName === 'web_fetch') {
        current.fetchCount++
        const facts = data?.facts || data || {}
        if (facts.usableEvidence === true) {
            if (facts.evidenceKey) {
                keys.add(String(facts.evidenceKey))
                fetchedKeys.add(String(facts.evidenceKey))
            }
            if (facts.domain) domains.add(String(facts.domain))
        } else {
            current.lowQualityCount++
        }
    }
    current.evidenceKeys = [...keys].sort()
    current.fetchedEvidenceKeys = [...fetchedKeys].sort()
    current.domains = [...domains].sort()
    current.usableFetchCount = current.fetchedEvidenceKeys.length
    current.quality = current.usableFetchCount >= 1 && current.domains.length >= 2
        ? 'high'
        : (current.evidenceKeys.length >= 2 && current.domains.length >= 2 ? 'medium' : 'low')
    current.sufficientForSensitiveClaims = current.quality === 'high'
    return current
}

export function buildWebEvidenceFingerprint(state = {}) {
    return JSON.stringify({
        evidenceKeys: [...new Set(state.evidenceKeys || [])].sort(),
        fetchedEvidenceKeys: [...new Set(state.fetchedEvidenceKeys || [])].sort(),
        domains: [...new Set(state.domains || [])].sort(),
        usableFetchCount: Math.max(0, Number(state.usableFetchCount) || 0),
        quality: state.quality || 'low'
    })
}

export function isSensitivePersonResearch(text = '') {
    const value = String(text || '')
    const person = /(?:UP主|up主|博主|主播|作者|艺人|明星|网友|个人|本人|账号|用户|公司|组织|机构|官方)/i.test(value)
    const dispute = /(?:事件|争议|黑料|违法|违规|犯罪|卖血|诈骗|造假|抄袭|封禁|塌房|举报|指控|回应|来龙去脉|始末)/i.test(value)
    return person && dispute
}

export function hasOverconfidentLowEvidenceAnswer(answer = '', instruction = '', evidenceState = {}) {
    if (!isSensitivePersonResearch(instruction) || evidenceState?.sufficientForSensitiveClaims === true) return false
    const value = String(answer || '')
    const uncertainty = /(?:未能核实|无法核实|尚未找到|没有找到|只能确认|搜索摘要|网传|据称|有人声称|暂不能确定|证据不足|原始材料缺失|可靠来源不足)/i.test(value)
    const definitive = /(?:违法|违规|犯罪|卖血|诈骗|造假|收取.{0,12}\d+|在20\d{2}年|事件发酵后|成为.{0,12}外号|引发.{0,20}讨论|事实是|可以确认)/i.test(value)
    return definitive && !uncertainty
}
