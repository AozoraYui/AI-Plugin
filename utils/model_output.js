const INTERNAL_TAGS = ['think', 'analysis', 'reasoning']
const FINAL_SECTION_RE = /^(?:#{1,6}\s*)?(?:final(?:\s+answer|\s+response)?|answer|最终答案|最终回复|答复|结论)\s*[：:]?\s*/i
const INTERNAL_SECTION_RE = /^(?:#{1,6}\s*)?(?:\*{0,2}(?:thinking|analysis|reasoning)\*{0,2}|思考过程|思维过程|推理过程|分析过程|内部思考|内部推理)\s*[：:]?\s*/i
const PLAN_HEADING_RE = /^(?:#{1,6}\s*)?(?:【\s*)?(?:工具规划|工具调用规划|行动计划|执行计划|下一步计划)(?:\s*】)?\s*[：:]?\s*/i

function stripInternalTags(text) {
    let result = text
    for (const tag of INTERNAL_TAGS) {
        const complete = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi')
        const unclosed = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, 'gi')
        result = result.replace(complete, '').replace(unclosed, '')
    }
    return result
}

function stripLeadingInternalSection(text) {
    const lines = String(text || '').split('\n')
    const firstContentIndex = lines.findIndex(line => line.trim())
    if (firstContentIndex < 0) return ''

    const firstLine = lines[firstContentIndex].trim()
    if (INTERNAL_SECTION_RE.test(firstLine)) {
        const finalIndex = lines.findIndex((line, index) => index > firstContentIndex && FINAL_SECTION_RE.test(line.trim()))
        if (finalIndex < 0) return ''
        lines[finalIndex] = lines[finalIndex].replace(FINAL_SECTION_RE, '')
        return lines.slice(finalIndex).join('\n').trim()
    }

    if (firstLine.startsWith('>')) {
        let index = firstContentIndex
        while (index < lines.length && (!lines[index].trim() || lines[index].trim().startsWith('>'))) index++
        return lines.slice(index).join('\n').trim()
    }

    return lines.join('\n').trim()
}

export function sanitizeModelOutput(text, options = {}) {
    let result = String(text || '').trim()
    if (!result) return ''
    if (options.showThinking !== true) {
        result = stripInternalTags(result)
        result = stripLeadingInternalSection(result)
    }
    return result.trim()
}

export function sanitizePlainTextOutput(text, options = {}) {
    return sanitizeModelOutput(text, options)
        .replace(/```[^\n]*\n?/g, '')
        .replace(/^\s{0,3}#{1,6}\s*/gm, '')
        .replace(/^\s*>\s?/gm, '')
        .replace(/^\s*[-+*]\s+/gm, '• ')
        .replace(/\*\*([^*\n]+)\*\*/g, '$1')
        .replace(/__([^_\n]+)__/g, '$1')
        .replace(/\*([^*\n]+)\*/g, '$1')
        .replace(/_([^_\n]+)_/g, '$1')
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '$1（$2）')
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

export function isPlanOnlyResponse(text) {
    const value = String(text || '').trim()
    if (!value) return false
    if (PLAN_HEADING_RE.test(value)) return true

    const compact = value.replace(/\s+/g, ' ').slice(0, 600)
    const futureAction = /^(?:我(?:将|会|需要|先|接下来)|下一步(?:我)?(?:会|将|需要)|需要先)(?:去|先)?(?:查看|读取|打开|搜索|查询|检查|调用|执行|运行|使用)/i.test(compact)
    const resultEvidence = /(?:结果|显示|内容是|查到|读取到|工具返回|命令输出|因此|所以|结论)/i.test(compact)
    return futureAction && !resultEvidence
}

export function hasUnsupportedToolResultClaim(text, options = {}) {
    if (options.hasActualToolResults === true) return false
    const value = sanitizeModelOutput(text, options)
    if (!value) return false
    const completionClaim = /(?:我(?:已经|已|刚刚|刚才)?(?:为你|帮你)?(?:完成|执行|运行|调用|查看|读取|检查|搜索|查询|安装|补全|补齐|修复|编译|构建|部署|发送|上传)|已经(?:为你|帮你)?(?:完成|执行|运行|调用|查看|读取|检查|搜索|查询|安装|补全|补齐|修复|编译|构建|部署|发送|上传)|(?:操作|命令|任务|依赖|模块|编译|构建|部署|文件|消息)(?:已经|已)(?:成功)?(?:完成|执行|运行|安装|补全|补齐|修复|编译|构建|部署|发送|上传)|(?:已|已经)(?:成功)?(?:切换到|运行了|执行了|读取了|查看了|搜索了|安装了|补全了|修复了|编译了|发送了|上传了))/i.test(value)
    const successConclusion = /(?:均已成功|已经修复好|已修复好|已经处理好|已处理好|执行成功|安装成功|编译成功|构建成功|部署成功|发送成功|上传成功|任务完成)/i.test(value)
    return completionClaim || successConclusion
}

export function needsFinalAnswerRetry(text, options = {}) {
    const sanitized = sanitizeModelOutput(text, options)
    return !sanitized || isPlanOnlyResponse(sanitized)
}

export function buildFinalAnswerRetryInstruction(options = {}) {
    const toolAudit = options.hasActualToolResults === true
        ? '本轮确实执行过工具；只有原始上下文中由系统注入的工具结果区块才是真实工具结果。'
        : '本轮没有执行任何工具；不得声称刚刚查看了文件、运行了命令、搜索了网页或取得了新的工具结果。'
    const issue = options.unsupportedToolClaim === true
        ? '上一条输出声称完成了工具操作，但本轮没有对应的真实工具执行证据。'
        : '上一条输出是内部思考或行动规划，不是可发送给用户的最终答复。'
    return `${issue}上一条异常输出本身不可信，不能把其中声称的工具调用或结果当作事实。${toolAudit}请重新基于原始上下文直接回答用户的问题。不要输出 Thinking、Analysis、思考过程、工具规划或下一步计划；不要声称执行了尚未执行的工具。如果缺少完成请求所需的真实结果，请明确说明目前无法确认，不能猜测。`
}
