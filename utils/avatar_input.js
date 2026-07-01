import { getAvatarUrl, takeSourceMsg } from './common.js'
import { processImageForAI } from './image.js'

function normalizeImageLimit(value, fallback) {
    if (value === Infinity) return Infinity
    const num = Number(value)
    if (num === Infinity) return Infinity
    return Number.isFinite(num) && num >= 0 ? Math.floor(num) : fallback
}

function getBotUin(event = {}) {
    return String(event.self_id || event.bot?.uin || event.bot?.self_id || (typeof Bot !== 'undefined' ? Bot.uin : '') || '')
}

function getSenderName(event = {}) {
    return event.sender?.card || event.sender?.nickname || event.member?.card || event.member?.nickname || `QQ ${event.user_id}`
}

function addTarget(targets, seen, id, label, relation) {
    const userId = String(id || '').trim()
    if (!userId || userId === 'all' || seen.has(userId)) return
    seen.add(userId)
    targets.push({ userId, label: label || `QQ ${userId}`, relation: relation || '头像' })
}

function extractAtIds(message = [], botUserId = '') {
    const ids = []
    const seen = new Set()
    for (const seg of message || []) {
        if (seg?.type !== 'at') continue
        const qq = seg.qq || seg.user_id || seg.data?.qq || seg.data?.user_id
        const id = String(qq || '').trim()
        if (!id || id === 'all') continue
        if (botUserId && id === botUserId) continue
        if (seen.has(id)) continue
        seen.add(id)
        ids.push(id)
    }
    return ids
}

function isThirdPersonAvatarRequest(text) {
    return /(?:他|她|ta|TA|这位|这个人|那位|那个人).{0,10}头像|头像.{0,10}(?:他|她|ta|TA|这位|这个人|那位|那个人)/i.test(String(text || ''))
}

async function resolveReplySenderTarget(event, text) {
    if (!isThirdPersonAvatarRequest(text)) return null
    const hasReply = event?.source || (event?.message || []).some(seg => seg?.type === 'reply')
    if (!hasReply) return null

    try {
        const source = await takeSourceMsg(event)
        const userId = source?.user_id || source?.sender?.user_id || source?.sender?.user_id_str
        if (!userId) return null
        const nickname = source?.nickname || source?.sender?.card || source?.sender?.nickname || `QQ ${userId}`
        return { userId: String(userId), label: `被回复用户 ${nickname}(${userId})`, relation: '被回复用户头像' }
    } catch (err) {
        logger.warn(`[AI-Plugin] 获取被回复用户头像目标失败: ${err.message}`)
        return null
    }
}

export function isAvatarReadRequest(text = '') {
    const value = String(text || '').trim()
    if (!value || !/头像/.test(value)) return false

    if (/(?:画|绘制|生成|创作|做|制作|设计|换|更换|改|修改|处理|修|手办化|风格化|转成).{0,14}头像|头像.{0,14}(?:画|绘制|生成|创作|做|制作|设计|换|更换|改|修改|处理|修|手办化|风格化|转成)/i.test(value)) {
        return false
    }

    return /(?:看|看看|看一下|看到|看见|看得到|能看到|能看见|识别|读|分析|描述|评价|点评|认出).{0,24}头像/i.test(value)
        || /头像.{0,24}(?:看|看看|看到|看见|看得到|是什么|长什么样|内容|样子|好看|像什么|评价|点评|怎么样|咋样|如何|呢|吗|嘛|么|[?？])/i.test(value)
}

export async function resolveAvatarTargets(event = {}, text = '') {
    const value = String(text || '')
    const botUserId = getBotUin(event)
    const atIds = extractAtIds(event.message || [], botUserId)
    const targets = []
    const seen = new Set()

    for (const id of atIds) {
        addTarget(targets, seen, id, `@成员 QQ ${id}`, '@成员头像')
    }

    const asksSelf = /(?:我|我的|俺|咱|自己).{0,10}头像|头像.{0,10}(?:我|我的|俺|咱|自己)/i.test(value)
    const asksBot = /(?:你的|你自己|诺亚|noa|机器人|AI).{0,10}头像|头像.{0,10}(?:你的|你自己|诺亚|noa|机器人|AI)/i.test(value)
    const asksOther = isThirdPersonAvatarRequest(value)

    const replyTarget = await resolveReplySenderTarget(event, value)
    if (replyTarget) {
        addTarget(targets, seen, replyTarget.userId, replyTarget.label, replyTarget.relation)
    }

    if (asksSelf || (targets.length === 0 && !asksBot && !asksOther)) {
        addTarget(targets, seen, event.user_id, `${getSenderName(event)}(${event.user_id})`, '触发者头像')
    }

    if (asksBot && botUserId) {
        addTarget(targets, seen, botUserId, `机器人 QQ ${botUserId}`, '机器人头像')
    }

    return targets
}

export async function buildAvatarImageInputContext(event = {}, text = '', options = {}) {
    if (!isAvatarReadRequest(text)) {
        return { imageParts: [], noteText: '', targets: [], failures: [] }
    }

    const maxImages = normalizeImageLimit(options.maxImages, 3)
    const targets = await resolveAvatarTargets(event, text)
    if (targets.length === 0) {
        return {
            imageParts: [],
            noteText: '【本轮头像图片输入】用户问到了头像，但当前消息没有明确头像对象；请反问用户要看谁的头像。',
            targets: [],
            failures: []
        }
    }

    const pickedTargets = maxImages === Infinity ? targets : targets.slice(0, maxImages)
    const omitted = Math.max(0, targets.length - pickedTargets.length)
    const imageParts = []
    const attachedTargets = []
    const failures = []

    for (const target of pickedTargets) {
        const url = await getAvatarUrl(target.userId)
        const imagePart = await processImageForAI(url)
        if (imagePart) {
            imageParts.push(imagePart)
            attachedTargets.push({ ...target, url })
        } else {
            failures.push(target)
        }
    }

    const lines = []
    if (attachedTargets.length > 0) {
        lines.push('以下头像图片已按顺序作为本轮多模态输入附加，请只基于这些实际附加的头像回答：')
        attachedTargets.forEach((target, index) => {
            lines.push(`${index + 1}. ${target.relation}：${target.label}（QQ ${target.userId}）`)
        })
    }
    if (failures.length > 0) {
        lines.push(`有 ${failures.length} 个头像获取失败，请不要描述这些失败的头像。`)
    }
    if (omitted > 0) {
        lines.push(`还有 ${omitted} 个头像因本轮图片上限未附加，请不要描述未附加的头像。`)
    }
    lines.push('头像图片只用于回答当前头像相关问题，不是历史聊天记录，也不是工具执行结果。')

    return {
        imageParts,
        noteText: `【本轮头像图片输入】\n${lines.join('\n')}`,
        targets: attachedTargets,
        failures
    }
}
