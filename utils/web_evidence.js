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

const WEAK_LANDING_PATHS = new Set(['', '/', '/home', '/index', '/index.html', '/default.html'])

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
    const asksOfficialSource = /(?:官方|正式|公告|通报|发布|升级|适配|名单|推送)/i.test(value)
    const requiresAuthoritativeSource = /(?:官方|正式(?:发布|公告|来源)?|官方来源|官方名单|官方说明)/i.test(value)
    const asksSourceBackedFact = /(?:发布|升级|适配|名单|推送|版本|价格|政策|公告|通报|计划)/i.test(value)
    const asksFreshness = /(?:最新|目前|现在|当前|截至|实时|近期|今天|今日|昨天|明天|最近)/i.test(value)
    const asksFactCheck = /(?:核实|核查|查证|查真|真假|是否真实|是否属实|有没有发生|是否发生|是否存在)/i.test(value)
    const scopeTerms = extractResearchScopeTerms(value)
    const requiresFetch = asksCompleteList || asksOfficialSource || asksSourceBackedFact || asksFreshness || asksFactCheck
    return {
        scopeTerms,
        asksCompleteList,
        asksOfficialSource,
        requiresAuthoritativeSource,
        asksSourceBackedFact,
        asksFreshness,
        asksFactCheck,
        requiresFetch,
        preserveScope: scopeTerms.length > 0 || asksCompleteList,
        requiresIndependentConfirmation: asksFactCheck
    }
}

export function hasInsufficientWebEvidenceForRequirements(state = {}, requirements = {}) {
    if (!requirements?.requiresFetch) return false
    if (Number(state.usableFetchCount) <= 0) return true
    const fetchedSourceCount = Number(state.fetchedSourceCount || state.usableFetchCount || 0)
    if (requirements.requiresIndependentConfirmation && fetchedSourceCount < 2) return true
    if (requirements.requiresAuthoritativeSource || (requirements.asksOfficialSource && requirements.asksCompleteList && state.authoritativeSourceRequired === true)) {
        const authoritativeDomains = state.fetchedAuthoritativeDomains || state.fetchedOfficialDomains || []
        if (!Array.isArray(authoritativeDomains) || authoritativeDomains.length === 0) return true
    }
    if (requirements.asksCompleteList && Object.prototype.hasOwnProperty.call(state, 'coverage')) {
        if (state.coverage !== 'complete') return true
    }
    return false
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

export function normalizeWebUrlKey(rawUrl = '') {
    return stableUrlKey(rawUrl)
}

export function scoreWebSourceCandidate(item = {}, query = '') {
    const url = item?.url || item?.pageUrl || ''
    const urlInfo = classifyWebUrl(url)
    if (!urlInfo.direct) return { score: -1000, tier: 'unusable', reasons: [urlInfo.reason] }
    const title = compactText(item?.title || '')
    const snippet = compactText(item?.snippet || '')
    const parsed = safeUrl(url)
    const normalizedQuery = compactText(query).toLowerCase()
    const haystack = (title + ' ' + snippet).toLowerCase()
    let score = 20
    const reasons = ['直接来源']
    const relevanceScore = Number(item?.relevanceScore)
    if (Number.isFinite(relevanceScore)) {
        score += Math.min(45, Math.max(0, relevanceScore))
        reasons.push('相关性' + Math.round(relevanceScore))
    }
    const engineHits = Number(item?.engineHits || 0)
    if (engineHits > 1) {
        score += Math.min(12, (engineHits - 1) * 4)
        reasons.push('多个搜索引擎同时命中' + engineHits + '次')
    }
    if (normalizedQuery && haystack.includes(normalizedQuery)) {
        score += 8
        reasons.push('标题或摘要覆盖完整查询')
    }
    if (snippet.length >= 80) score += 8
    else if (snippet.length >= 24) score += 3
    else reasons.push('摘要较短')
    if (isLikelyAuthoritativeWebDomain(urlInfo.domain)) {
        score += 28
        reasons.push('域名带有公共权威信号')
    }
    if (parsed && WEAK_LANDING_PATHS.has(parsed.pathname.toLowerCase())) {
        score -= 30
        reasons.push('站点首页或落地页')
    } else if (parsed && /\/(?:article|news|post|detail|content|report|notice|announcement|p|a|docs?)\b/i.test(parsed.pathname)) {
        score += 6
        reasons.push('疑似正文路径')
    }
    if (/(?:官方|公告|通报|通知|发布说明|完整名单|升级名单|适配名单)/i.test(title + ' ' + snippet)) {
        score += 6
        reasons.push('标题或摘要带研究任务信号')
    }
    const tier = isLikelyAuthoritativeWebDomain(urlInfo.domain)
        ? 'authoritative'
        : (parsed && !WEAK_LANDING_PATHS.has(parsed.pathname.toLowerCase()) ? 'direct' : 'landing')
    return { score, tier, reasons }
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

export function assessSearchResults(results = [], query = '') {
    const enriched = (Array.isArray(results) ? results : []).map(item => {
        const urlInfo = classifyWebUrl(item?.url || item?.pageUrl || '')
        const snippet = compactText(item?.snippet || '')
        const title = compactText(item?.title || '')
        const hasUsefulSnippet = snippet.length >= 24
        const usableEvidence = urlInfo.direct && hasUsefulSnippet
        const evidenceKey = usableEvidence ? stableUrlKey(item?.url || item?.pageUrl || '') : ''
        const sourceScore = scoreWebSourceCandidate({ ...item, title, snippet }, query)
        return {
            ...item,
            domain: urlInfo.domain,
            sourceCategory: urlInfo.category,
            directSource: urlInfo.direct,
            autoFetchEligible: urlInfo.autoFetchEligible,
            usableEvidence,
            sourceScore: sourceScore.score,
            sourceTier: sourceScore.tier,
            sourceReasons: sourceScore.reasons,
            qualityReason: usableEvidence ? '直接来源且搜索摘要包含有效文本' : (urlInfo.reason || '摘要过短'),
            evidenceKey
        }
    })
    const ranked = [...enriched].sort((left, right) => {
        if (right.sourceScore !== left.sourceScore) return right.sourceScore - left.sourceScore
        return Number(right.relevanceScore || 0) - Number(left.relevanceScore || 0)
    })
    const usable = ranked.filter(item => item.usableEvidence)
    const independentDomains = [...new Set(usable.map(item => item.domain).filter(Boolean))]
    const evidenceKeys = [...new Set(usable.map(item => item.evidenceKey).filter(Boolean))]
    const quality = independentDomains.length >= 3 && evidenceKeys.length >= 3
        ? 'high'
        : (independentDomains.length >= 2 && evidenceKeys.length >= 2 ? 'medium' : 'low')
    const directCandidates = ranked.filter(item => item.autoFetchEligible)
    const autoFetchCandidates = directCandidates.filter(item => item.usableEvidence || isLikelyAuthoritativeWebDomain(item.domain))
    const autoFetchCandidate = autoFetchCandidates[0] || null
    return {
        results: ranked,
        quality,
        usableEvidenceCount: usable.length,
        independentSourceCount: independentDomains.length,
        independentDomains,
        evidenceKeys,
        autoFetchCandidate,
        autoFetchCandidates,
        directCandidates,
        recommendedSources: autoFetchCandidates.slice(0, 8).map(item => ({
            url: item.url,
            title: item.title,
            domain: item.domain,
            score: item.sourceScore,
            tier: item.sourceTier,
            reasons: item.sourceReasons
        })),
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

    const evidenceKey = usableEvidence ? stableUrlKey(effectiveUrl) : ''
    const truncated = /(?:已截断|内容过长已截断|超过.{0,12}字符上限)/i.test(raw)
    const hasCompleteListLanguage = /(?:完整名单|全部名单|名单如下|共\s*\d+\s*(?:款|个|项|台|部)|包括以下(?:机型|项目|内容))/i.test(text)
    const hasPartialListLanguage = /(?:首批|部分|其中|例如|代表|陆续|后续|第一批|第二批|部分机型|仅列出|不完整)/i.test(text)
    const negatesCompleteLanguage = /(?:并非|不是|不等于|不能视为|仅为|仅包含).{0,10}(?:完整|全部)/i.test(text)
    const coverage = truncated || negatesCompleteLanguage
        ? 'partial'
        : (hasCompleteListLanguage && !hasPartialListLanguage ? 'complete' : (hasPartialListLanguage ? 'partial' : 'unknown'))
    const authoritativeDomain = isLikelyAuthoritativeWebDomain(urlInfo.domain)
    const authoritySignals = [
        authoritativeDomain ? '域名带公共权威后缀' : '',
        /(?:官方公告|官方通知|正式公告|发布说明)/i.test(text) ? '正文包含官方发布语义' : ''
    ].filter(Boolean)
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
        coverage,
        truncated,
        authoritativeDomain,
        authoritySignals,
        evidenceKey,
        facts: {
            requestedUrl,
            effectiveUrl,
            domain: urlInfo.domain,
            sourceCategory: urlInfo.category,
            quality,
            usableEvidence,
            contentChars: text.length,
            coverage,
            truncated,
            authoritativeDomain,
            authoritySignals,
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
        fetchedAuthoritativeDomains: [...new Set(state.fetchedAuthoritativeDomains || state.fetchedOfficialDomains || [])],
        fetchedOfficialDomains: [...new Set(state.fetchedOfficialDomains || state.fetchedAuthoritativeDomains || [])],
        usableFetchCount: Math.max(0, Number(state.usableFetchCount) || 0),
        fetchedSourceCount: Math.max(0, Number(state.fetchedSourceCount) || 0),
        coverage: state.coverage || 'unknown',
        coverageSources: Math.max(0, Number(state.coverageSources) || 0),
        truncatedFetchCount: Math.max(0, Number(state.truncatedFetchCount) || 0),
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
    const fetchedOfficialDomains = new Set(current.fetchedOfficialDomains)
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
            if (facts.domain && (facts.authoritativeDomain === true || isLikelyAuthoritativeWebDomain(facts.domain))) {
                fetchedAuthoritativeDomains.add(String(facts.domain))
                fetchedOfficialDomains.add(String(facts.domain))
            }
            if (facts.coverage === 'complete') {
                current.coverage = 'complete'
                current.coverageSources++
            } else if (facts.coverage === 'partial' || facts.truncated === true) {
                if (current.coverage !== 'complete') current.coverage = 'partial'
                if (facts.truncated === true) current.truncatedFetchCount++
            }
        } else {
            current.lowQualityCount++
        }
    }
    current.evidenceKeys = [...keys].sort()
    current.fetchedEvidenceKeys = [...fetchedKeys].sort()
    current.domains = [...domains].sort()
    current.fetchedAuthoritativeDomains = [...fetchedAuthoritativeDomains].sort()
    current.fetchedOfficialDomains = [...fetchedOfficialDomains].sort()
    current.usableFetchCount = current.fetchedEvidenceKeys.length
    current.fetchedSourceCount = current.fetchedEvidenceKeys.length
    current.quality = current.usableFetchCount >= 2 && current.domains.length >= 2
        ? 'high'
        : (current.usableFetchCount >= 1 ? 'medium' : 'low')
    current.sufficientForSensitiveClaims = current.quality === 'high'
    return current
}

export function buildWebEvidenceFingerprint(state = {}) {
    return JSON.stringify({
        evidenceKeys: [...new Set(state.evidenceKeys || [])].sort(),
        fetchedEvidenceKeys: [...new Set(state.fetchedEvidenceKeys || [])].sort(),
        domains: [...new Set(state.domains || [])].sort(),
        fetchedAuthoritativeDomains: [...new Set(state.fetchedAuthoritativeDomains || [])].sort(),
        coverage: state.coverage || 'unknown',
        coverageSources: Number(state.coverageSources) || 0,
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
    if (!requirements.preserveScope) return false
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
    const requirements = buildWebResearchRequirements(instruction)
    if (evidenceState?.sufficientForSensitiveClaims === true && !hasInsufficientWebEvidenceForRequirements(evidenceState, requirements)) return false
    const value = String(answer || '')
    const uncertainty = /(?:未能核实|无法核实|尚未找到|没有找到|只能确认|搜索摘要|网传|据称|有人声称|暂不能确定|证据不足|原始材料缺失|可靠来源不足)/i.test(value)
    const sensitivePersonClaim = isSensitivePersonResearch(instruction)
        && /(?:违法|违规|犯罪|卖血|诈骗|造假|收取.{0,12}\d+|在20\d{2}年|事件发酵后|成为.{0,12}外号|引发.{0,20}讨论|事实是|可以确认)/i.test(value)
    const publicFactClaim = hasEvidenceAttempt && isPublicFactCheckRequest(instruction) && hasDefinitivePublicFactDenial(value)
    const unavailableClaim = evidenceState?.searchUnavailable === true
        && /(?:搜索失败|搜索源|网络搜索|联网|没有搜到|未找到结果|查不到)/i.test(value)
    const scopeMismatch = hasResearchScopeMismatch(value, instruction, evidenceState)
    const incompleteResearchClaim = requirements.requiresFetch
        && hasInsufficientWebEvidenceForRequirements(evidenceState, requirements)
        && !uncertainty
        && /(?:官方|正式|最新|当前|截至|全部|完整|所有|名单|价格|版本|政策|公告|已经|可以确认|明确|确定|属实|真实|存在|支持|不支持|发生|没有)/i.test(value)
    const unverifiedScopeDenial = requirements.preserveScope
        && hasInsufficientWebEvidenceForRequirements(evidenceState, requirements)
        && /(?:官方|正式).{0,16}(?:不存在|未发布|没有发布|尚未发布)|(?:不存在|未发布|没有发布|尚未发布).{0,16}(?:官方|正式)/i.test(value)
    return (sensitivePersonClaim || publicFactClaim || unavailableClaim || scopeMismatch || incompleteResearchClaim || unverifiedScopeDenial) && !uncertainty
}
