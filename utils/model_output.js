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

export function isPlanOnlyResponse(text) {
    const value = String(text || '').trim()
    if (!value) return false
    if (PLAN_HEADING_RE.test(value)) return true

    const compact = value.replace(/\s+/g, ' ').slice(0, 600)
    const futureAction = /^(?:我(?:将|会|需要|先|接下来)|下一步(?:我)?(?:会|将|需要)|需要先)(?:去|先)?(?:查看|读取|打开|搜索|查询|检查|调用|执行|运行|使用)/i.test(compact)
    const resultEvidence = /(?:结果|显示|内容是|查到|读取到|工具返回|命令输出|因此|所以|结论)/i.test(compact)
    return futureAction && !resultEvidence
}

export function needsFinalAnswerRetry(text, options = {}) {
    const sanitized = sanitizeModelOutput(text, options)
    return !sanitized || isPlanOnlyResponse(sanitized)
}

export const FINAL_ANSWER_RETRY_INSTRUCTION = `上一条输出是内部思考或行动规划，不是可发送给用户的最终答复。请基于现有上下文和已经提供的真实工具结果，直接回答用户的问题。不要输出 Thinking、Analysis、思考过程、工具规划或下一步计划；不要声称执行了尚未执行的工具。如果缺少完成请求所需的真实结果，请明确说明目前无法确认，不能猜测。`

