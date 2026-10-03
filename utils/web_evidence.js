const SEARCH_REDIRECT_RULES = [
    ['baidu.com', /^\/link/i],
    ['so.com', /^\/link/i],
    ['sogou.com', /^\/link/i],
    ['bing.com', /^\/ck\/a/i],
    ['google.com', /^\/url/i]
]

const SEARCH_PAGE_RULES = [
    ['baidu.com', /^\/(?:s|search)(?:\/|$)/i],
    ['bing.com', /^\/(?:search|images)(?:\/|$)/i],
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

const AUTHORITATIVE_DOMAIN_SUFFIXES = [
    '.gov',
    '.gov.cn',
    '.edu',
    '.edu.cn',
    '.mil',
    '.mil.cn'
]

function normalizeHost(hostname = '') {
    return String(hostname || '').toLowerCase().replace(/^www\./, '')
}

export function isLikelyAuthoritativeWebDomain(domain = '') {
    const host = normalizeHost(domain)
    if (!host) return false
    return AUTHORITATIVE_DOMAIN_SUFFIXES.some(suffix => host.endsWith(suffix) || host.includes(`${suffix}.`))
        || host.split('.').some(part => /^(?:official|gov|government|edu|university|museum)$/i.test(part))
}

export function buildWebResearchRequirements(instruction = '') {
    const value = String(instruction || '').replace(/\s+/g, ' ').trim()
    const asksCompleteList = /(?:全部|完整|所有|全量|全名单|完整名单|全部名单|所有机型|每一款|每个机型)/i.test(value)
    const asksOfficialSource = /(?:官方|正式|公告|发布|升级|适配|名单|推送|是否存在|有没有|真假|核实)/i.test(value)
    const asksFreshness = /(?:最新|目前|现在|当前|截至|实时|近期|今天|今日|昨天|明天|最近)/i.test(value)
    const asksFactCheck = /(?:核实|核查|查证|查真|真假|是否真实|是否属实|有没有发生|是否发生|是否存在)/i.test(value)
    const scopeTerms = extractResearchScopeTerms(value)
    const requiresFetch = asksCompleteList || asksOfficialSource || asksFreshness || asksFactCheck
    return {
        scopeTerms,
        asksCompleteList,
        asksOfficialSource,
        asksFreshness,
        asksFactCheck,
        requiresFetch,
        preserveScope: scopeTerms.length > 0 || asksCompleteList
    }
}

export function hasInsufficientWebEvidenceForRequirements(state = {}, requirements = {}) {
    if (!requirements?.requiresFetch) return false
    return Number(state.usableFetchCount) <= 0
}

export function extractResearchScopeTerms(text = '') {
    const value = String(text || '')
    const terms = new Set()
    for (const match of value.matchAll(/[A-Za-z][A-Za-z0-9._-]*\d[A-Za-z0-9._-]*/g)) {
        terms.add(match[0].toLowerCase())
    }
    for (const match of value.matchAll(/\b(?:v|ver|version|第)\s*\d+(?:\.\d+){0,3}\b/gi)) {
        terms.add(match[0].replace(/\s+/g, '').toLowerCase())
    }
    for (const match of value.matchAll(/[“「『"]([^”」』"]{2,40})[”」』"]/g)) {
        const term = match[1].replace(/\s+/g, ' ').trim().toLowerCase()
        if (term) terms.add(term)
    }
    return [...terms].slice(0, 12)
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
    const directCandidates = enriched.filter(item => item.autoFetchEligible)
    const autoFetchCandidates = enriched.filter(item => item.autoFetchEligible && (item.usableEvidence || isLikelyAuthoritativeWebDomain(item.domain)))
    const autoFetchCandidate = autoFetchCandidates[0] || null
    return {
        results: enriched,
        quality,
        usableEvidenceCount: usable.length,
        independentSourceCount: independentDomains.length,
        independentDomains,
        evidenceKeys,
        autoFetchCandidate,
        autoFetchCandidates,
        directCandidates,
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
        fetchedAuthoritativeDomains: [...new Set(state.fetchedAuthoritativeDomains || [])],
        usableFetchCount: Math.max(0, Number(state.usableFetchCount) || 0),
        lowQualityCount: Math.max(0, Number(state.lowQualityCount) || 0),
        searchCount: Math.max(0, Number(state.searchCount) || 0),
        fetchCount: Math.max(0, Number(state.fetchCount) || 0),
        searchUnavailableCount: Math.max(0, Number(state.searchUnavailableCount) || 0),
        searchFailureCount: Math.max(0, Number(state.searchFailureCount) || 0),
        searchSuccessCount: Math.max(0, Number(state.searchSuccessCount) || 0),
        searchUnavailable: state.searchUnavailable === true
    }
    const keys = new Set(current.evidenceKeys)
    const fetchedKeys = new Set(current.fetchedEvidenceKeys)
    const domains = new Set(current.domains)
    const fetchedAuthoritativeDomains = new Set(current.fetchedAuthoritativeDomains)
    if (toolName === 'web_search') {
        current.searchCount++
        if (data?.searchUnavailable === true) current.searchUnavailableCount++
        if (data?.transportFailure === true || data?.searchUnavailable === true) current.searchFailureCount++
        if (data?.searchUnavailable !== true && data?.transportFailure !== true) current.searchSuccessCount++
        current.searchUnavailable = data?.searchUnavailable === true
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
            if (facts.domain && isLikelyAuthoritativeWebDomain(facts.domain)) fetchedAuthoritativeDomains.add(String(facts.domain))
        } else {
            current.lowQualityCount++
        }
    }
    current.evidenceKeys = [...keys].sort()
    current.fetchedEvidenceKeys = [...fetchedKeys].sort()
    current.domains = [...domains].sort()
    current.fetchedAuthoritativeDomains = [...fetchedAuthoritativeDomains].sort()
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
        fetchedAuthoritativeDomains: [...new Set(state.fetchedAuthoritativeDomains || [])].sort(),
        usableFetchCount: Math.max(0, Number(state.usableFetchCount) || 0),
        quality: state.quality || 'low',
        searchUnavailable: state.searchUnavailable === true
    })
}

export function isSensitivePersonResearch(text = '') {
    const value = String(text || '')
    const person = /(?:UP主|up主|博主|主播|作者|艺人|明星|网友|个人|本人|账号|用户|公司|组织|机构|官方)/i.test(value)
    const dispute = /(?:事件|争议|黑料|违法|违规|犯罪|卖血|诈骗|造假|抄袭|封禁|塌房|举报|指控|回应|来龙去脉|始末)/i.test(value)
    return person && dispute
}

function isPublicFactCheckRequest(text = '') {
    return /(?:是否发生|有没有发生|有沒有发生|真实|现实中|从未|根本没有|官方报道|央视|战争|空战|军事|武器|战果|冲突|事故|灾害|政治|公共事件|历史事件|事实核查|核查|真假|谣言)/i.test(String(text || ''))
}

function hasDefinitivePublicFactDenial(text = '') {
    return /(?:不存在|没有发生|没发生过|从未发生|根本没发生|完全是虚构|纯属虚构|现实中不存在|没有任何真实记录|从未报道|没有报道过|确定是谣言|必然是假的|事实不存在|不可能发生)/i.test(String(text || ''))
}

function scopeFamily(term = '') {
    return String(term || '').toLowerCase().replace(/\d.*$/, '').replace(/[^a-z]+/g, '')
}

function hasResearchScopeMismatch(answer = '', instruction = '', evidenceState = {}) {
    const requirements = buildWebResearchRequirements(instruction)
    if (!requirements.preserveScope || Number(evidenceState?.usableFetchCount || 0) > 0) return false
    const requestedTerms = new Set(requirements.scopeTerms)
    const answerTerms = extractResearchScopeTerms(answer)
    const alternateScope = answerTerms.some(term => {
        const family = scopeFamily(term)
        return family && [...requestedTerms].some(requested => scopeFamily(requested) === family && requested !== term)
    })
    const definitiveClaim = /(?:官方|正式发布|已经发布|尚未发布|不存在|升级名单|适配名单|完整名单|全部名单|可以确认|明确)/i.test(String(answer || ''))
    return alternateScope && definitiveClaim
}

export function hasUnsupportedWebResearchClaim(answer = '', instruction = '', evidenceState = {}) {
    const value = String(answer || '')
    const request = String(instruction || '')
    const hasWebRequest = /(?:联网|上网|搜索|搜一下|查一下|查询|检索|核查|查证|查查|搜查)/i.test(request)
    if (!hasWebRequest) return false
    const hasEvidence = Number(evidenceState?.searchCount || 0) > 0 || Number(evidenceState?.fetchCount || 0) > 0
    if (hasEvidence) return false
    if (/(?:无法|不能|没法|没有办法|暂时不能|尚未|未能|未找到|没有找到|缺少|不足|不确定|无法确认|不能确认).{0,24}(?:联网|搜索|核查|查证|确认|核实)/i.test(value)) return false
    return /(?:经过|根据|结合|通过).{0,24}(?:联网|网络|搜索|相关信息|相关通报|资料|核查|查证|调查).{0,30}(?:可以明确|可以确认|明确|证实|证明|属实|真实|是真的|是假的|虚假|谣言|不实|发生过|没有发生)|(?:已经|已|刚刚|刚才)(?:联网|搜索|核查|查证|调查).{0,24}(?:到|出|确认|发现|证实|证明)|(?:官方|相关部门|新闻媒体|正规媒体).{0,20}(?:通报|证实|确认|证明).{0,20}(?:属实|真实|发生|不存在|虚假|谣言|不实)/i.test(value)
}

export function hasOverconfidentLowEvidenceAnswer(answer = '', instruction = '', evidenceState = {}) {
    const hasEvidenceAttempt = Number(evidenceState?.searchCount || 0) > 0 || Number(evidenceState?.fetchCount || 0) > 0
    if (evidenceState?.sufficientForSensitiveClaims === true) return false
    const value = String(answer || '')
    const uncertainty = /(?:未能核实|无法核实|尚未找到|没有找到|只能确认|搜索摘要|网传|据称|有人声称|暂不能确定|证据不足|原始材料缺失|可靠来源不足)/i.test(value)
    const sensitivePersonClaim = isSensitivePersonResearch(instruction)
        && /(?:违法|违规|犯罪|卖血|诈骗|造假|收取.{0,12}\d+|在20\d{2}年|事件发酵后|成为.{0,12}外号|引发.{0,20}讨论|事实是|可以确认)/i.test(value)
    const publicFactClaim = hasEvidenceAttempt && isPublicFactCheckRequest(instruction) && hasDefinitivePublicFactDenial(value)
    const unavailableClaim = evidenceState?.searchUnavailable === true
        && /(?:搜索失败|搜索源|网络搜索|联网|没有搜到|未找到结果|查不到)/i.test(value)
    const scopeMismatch = hasResearchScopeMismatch(value, instruction, evidenceState)
    const requirements = buildWebResearchRequirements(instruction)
    const incompleteResearchClaim = requirements.requiresFetch
        && Number(evidenceState?.usableFetchCount || 0) <= 0
        && !uncertainty
        && /(?:官方|正式|最新|当前|截至|全部|完整|所有|名单|价格|版本|政策|公告|已经|可以确认|明确|确定|属实|真实|存在|支持|不支持|发生|没有)/i.test(value)
    const unverifiedScopeDenial = requirements.preserveScope
        && Number(evidenceState?.usableFetchCount || 0) <= 0
        && /(?:官方|正式).{0,16}(?:不存在|未发布|没有发布|尚未发布)|(?:不存在|未发布|没有发布|尚未发布).{0,16}(?:官方|正式)/i.test(value)
    return (sensitivePersonClaim || publicFactClaim || unavailableClaim || scopeMismatch || incompleteResearchClaim || unverifiedScopeDenial) && !uncertainty
}
