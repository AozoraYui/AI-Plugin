import { isAIErrorResponse } from './common.js'

const OLD_PROFILE_MAX_CHARS = 12000
const SUMMARY_SOURCE_MAX_CHARS = 36000
const PROFILE_OUTPUT_MAX_TOKENS = 4096

function truncateText(value, maxChars) {
    const text = String(value || '').trim()
    if (text.length <= maxChars) return text
    return text.slice(0, maxChars) + '\n[内容过长，后续已截断]'
}

function normalizeSummaryType(type = '') {
    const value = String(type || '').trim().toLowerCase()
    if (value === 'full') return '全量总结'
    if (value === 'incremental') return '增量总结'
    return value || '记忆总结'
}

function buildUserProfilePrompt({ oldProfile, summaryText, summaryType, dateStr }) {
    const oldProfileText = oldProfile
        ? truncateText(oldProfile.info || oldProfile, OLD_PROFILE_MAX_CHARS)
        : '暂无旧档案。'
    const sourceText = truncateText(summaryText, SUMMARY_SOURCE_MAX_CHARS)
    const summaryLabel = normalizeSummaryType(summaryType)
    const dateLabel = dateStr ? `日期：${dateStr}` : '日期：未知'

    return `你是一个谨慎的个人档案维护器。你的任务是根据“旧个人档案”和“本次记忆总结”，比对变化并输出一份更新后的个人档案。

【维护原则】
1. 个人档案用于帮助 AI 后续理解这个用户，只记录长期稳定或多次出现的信息：偏好、习惯、长期项目、技术栈、关系上下文、称呼偏好、雷点、表达风格等。
2. 如果本次总结出现了新的稳定信息，请合并进档案；如果新总结明确推翻旧信息，请更新旧信息。
3. 对一次性任务、临时命令、工具执行结果、短期情绪、纯闲聊噪声，不要写入档案。
4. 不要把群内对他人的调侃、攻击性称呼或未经确认的信息当作事实；必要时只写成“可能/曾提到/群内称呼”。
5. 不要编造旧档案和本次总结都没有的信息。
6. 输出纯文本，不要 Markdown 标题、不要代码块、不要解释你的处理过程。
7. 如果没有值得更新的新信息，也请输出整理后的旧档案，而不是说“没有变化”。

【建议结构】
基本信息与称呼：
偏好与习惯：
长期项目与技术上下文：
人际/群聊上下文：
需要注意的边界：

【旧个人档案】
${oldProfileText}

【本次${summaryLabel}】
${dateLabel}
${sourceText}

请直接输出更新后的个人档案。`
}

export async function updateUserProfileFromSummary(db, client, userId, summaryText, options = {}) {
    const userIdStr = String(userId || '').trim()
    const sourceText = String(summaryText || '').trim()
    if (!userIdStr || !sourceText) {
        return { ok: false, skipped: true, reason: '缺少用户或总结内容' }
    }
    if (!db?.getUserProfile || !db?.saveUserProfile || !client?.makeRequest) {
        return { ok: false, skipped: true, reason: '缺少用户档案依赖' }
    }

    try {
        const oldProfile = await db.getUserProfile(userIdStr)
        const prompt = buildUserProfilePrompt({
            oldProfile,
            summaryText: sourceText,
            summaryType: options.summaryType,
            dateStr: options.dateStr
        })
        const payload = { contents: [{ role: 'user', parts: [{ text: prompt }] }] }
        const modelGroupKey = options.modelGroupKey || 'flash'
        const result = await client.makeRequest('chat', payload, modelGroupKey, PROFILE_OUTPUT_MAX_TOKENS)

        if (!result.success || isAIErrorResponse(result.data)) {
            const reason = isAIErrorResponse(result.data) ? 'AI 安全过滤拦截' : (result.error || '模型无返回')
            logger.warn(`[AI-Plugin] 用户 ${userIdStr} 个人档案更新失败: ${reason}`)
            return { ok: false, skipped: false, reason }
        }

        const profileText = String(result.data || '').trim()
        if (!profileText) {
            logger.warn(`[AI-Plugin] 用户 ${userIdStr} 个人档案更新失败: 模型返回为空`)
            return { ok: false, skipped: false, reason: '模型返回为空' }
        }

        await db.saveUserProfile(userIdStr, profileText)
        logger.info(`[AI-Plugin] 用户 ${userIdStr} 个人档案已更新: 来源=${normalizeSummaryType(options.summaryType)}, 字符数=${profileText.length}`)
        return {
            ok: true,
            oldProfileExists: Boolean(oldProfile?.info),
            length: profileText.length,
            usage: result.usage || null
        }
    } catch (err) {
        logger.warn(`[AI-Plugin] 用户 ${userIdStr} 个人档案更新异常: ${err.message}`)
        return { ok: false, skipped: false, reason: err.message }
    }
}

export async function loadUserProfileText(db, userId, maxChars = 3200) {
    const userIdStr = String(userId || '').trim()
    if (!userIdStr || !db?.getUserProfile) return ''
    try {
        const profile = await db.getUserProfile(userIdStr)
        return profile?.info ? truncateText(profile.info, maxChars) : ''
    } catch (err) {
        logger.warn(`[AI-Plugin] 用户 ${userIdStr} 个人档案加载失败: ${err.message}`)
        return ''
    }
}
