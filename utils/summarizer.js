import { Config, expandPrompt } from './config.js'
import { isAIErrorResponse } from './common.js'

/**
 * 将对话历史数组构建为文本格式。
 * 用于作为总结的输入。
 */
export function buildHistoryText(history, aiName) {
    let text = ""
    for (const turn of history) {
        const role = turn.role === 'user' ? '用户' : aiName
        const content = turn.parts.map(p => p.text).join(' ')
        if (content) text += `${role}: ${content}\n`
    }
    return text
}

/**
 * 总结单个块（不分块时使用）。
 * 返回 { summary, usage } 或 null。
 */
export async function summarizeSingleChunk(historyText, modelGroupKey, client) {
    const template = Config.Prompts?.full_checkpoint?.single_chunk
        || `你是一位专业的传记作家和档案管理员。现在是【{current_time}】。\n请将以下这些原始对话整合成一份完整的、精炼的核心记忆存档。\n要求：\n1. 保留所有重要的用户信息（性格、偏好、技术能力、重要经历等）\n2. 按主题分类整理（如：个人信息、技术兴趣、重要对话、情感偏好等）\n3. 去除重复的内容，保留核心内容\n4. 字数不限，尽可能写好各处细节\n5. 直接输出整合后的记忆存档，不要加"好的"等客套话，严禁使用 Markdown 格式（如 **粗体**、# 标题等），请使用纯文本\n\n原始对话记录：`
    const prompt = expandPrompt(template, { current_time: new Date().toLocaleString('zh-CN', { hour12: false }) })
        + `\n${historyText}`

    const payload = { "contents": [{ "role": "user", "parts": [{ "text": prompt }] }] }
    const result = await client.makeRequest('chat', payload, modelGroupKey, Config.CHECKPOINT_MAX_LENGTH)

    if (result.success && !isAIErrorResponse(result.data)) {
        return { summary: result.data.trim(), usage: result.usage || null }
    }
    // 失败时降级：返回原始片段，避免数据完全丢失
    return { summary: historyText.slice(0, Config.FALLBACK_CHUNK_MAX_LENGTH), usage: null }
}

/**
 * 总结单个分块。
 * 返回 { summary, usage } 或 null。
 */
export async function summarizeChunk(chunkText, chunkIndex, totalChunks, modelGroupKey, client) {
    const template = Config.Prompts?.full_checkpoint?.per_chunk
        || `请将以下这段对话记录概括为一个详细的摘要（这是第 {chunk_index}/{total_chunks} 段）。\n重点记录：用户做了什么、讨论了什么话题、用户的情绪或重要偏好、重要的个人信息。\n直接输出摘要内容，不要加"好的"等客套话。请使用纯文本，严禁使用 Markdown 格式（如 **粗体**、# 标题等）。\n\n对话记录：`
    const prompt = expandPrompt(template, { chunk_index: chunkIndex, total_chunks: totalChunks })
        + `\n${chunkText}`

    const payload = { "contents": [{ "role": "user", "parts": [{ "text": prompt }] }] }
    const result = await client.makeRequest('chat', payload, modelGroupKey, Config.CHECKPOINT_MAX_LENGTH)

    if (result.success && !isAIErrorResponse(result.data)) {
        return { summary: result.data.trim(), usage: result.usage || null }
    }
    return null
}
