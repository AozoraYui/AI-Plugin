import { sanitizeModelOutput } from './model_output.js'

const CONTENT_REJECTION_RE = /违禁词|敏感词|内容(?:违规|不合规)|消息(?:违规|被拦截)|(?:本地发送)?拦截|风控|risk control|content blocked|content rejected|message is risky/i

export function extractMessageSendError(result) {
    if (result === false) return '发送接口返回 false，可能被本地发送拦截器拒绝'
    if (!result || typeof result !== 'object') return ''

    const failedStatus = /^(?:failed|error|fail)$/i.test(String(result.status || ''))
    const failedRetcode = Number.isFinite(Number(result.retcode)) && ![0, 1].includes(Number(result.retcode))
    if (!result.error && !result.errors && !failedStatus && !failedRetcode) return ''

    const messages = []
    const visited = new Set()
    const collect = (value, depth = 0) => {
        if (value === null || value === undefined || depth > 4) return
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            const text = String(value).trim()
            if (text && !messages.includes(text)) messages.push(text)
            return
        }
        if (typeof value !== 'object' || visited.has(value)) return
        visited.add(value)
        if (Array.isArray(value)) {
            value.forEach(item => collect(item, depth + 1))
            return
        }
        for (const key of ['message', 'msg', 'wording', 'error', 'errors', 'cause', 'retcode', 'status']) {
            if (value[key] !== undefined) collect(value[key], depth + 1)
        }
    }
    collect(result)
    return messages.join(' | ').slice(0, 1000) || '消息发送失败（适配器未返回详细原因）'
}

export function isContentModerationSendError(error) {
    return CONTENT_REJECTION_RE.test(String(error || ''))
}

export async function rewriteRejectedReply(client, text, modelGroupKey = 'flash', maxTokens = 4096) {
    const source = String(text || '').trim().slice(0, 16000)
    if (!source) return ''
    const payload = {
        contents: [{
            role: 'user',
            parts: [{
                text: `下面是一段原本要发送给用户、但被消息发送过滤器拒绝的答复。请保持核心事实和结论不变，改写成中性、简洁、自然且适合公开群聊发送的中文；删除可能触发过滤的粗俗、攻击性、露骨或高风险措辞，不要规避平台规则，不要解释改写过程，只输出改写后的答复。\n\n待改写答复：\n${source}`
            }]
        }]
    }
    const result = await client.makeRequest('chat', payload, modelGroupKey, maxTokens)
    if (!result?.success || !result.data) return ''
    return sanitizeModelOutput(result.data).trim()
}
