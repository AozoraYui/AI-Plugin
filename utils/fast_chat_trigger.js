function escapeRegExp(text = '') {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function isReferentialBotKeywordMention(instructionText = '', keyword = '') {
    const value = String(instructionText || '').trim()
    const name = String(keyword || '').trim()
    if (!value || !name) return false
    const escaped = escapeRegExp(name)
    return new RegExp(`(?:照着|按照|根据|依照|按|听|参考).{0,10}${escaped}.{0,10}(?:说的|讲的|提的|建议|说过|讲过|提过)|${escaped}.{0,10}(?:(?:刚才|之前|前面|上次)?(?:说的|讲的|提的|建议的|说过的|讲过的|提过的)|说得|讲得|认为|建议(?:我|他|她|大家|我们|应该|可以|要)|的(?:建议|说法|观点|方案))`, 'i').test(value)
}

export function resolveFastChatTrigger(options = {}) {
    const instructionText = String(options.instructionText || '').trim()
    const currentImageCount = Math.max(0, Math.floor(Number(options.currentImageCount) || 0))
    const shouldReadCurrentImages = options.triggerOnImage === true && currentImageCount > 0

    if (options.mentionedBot === true) {
        return { triggered: true, reason: 'mentioned_bot', forceReadCurrentImages: shouldReadCurrentImages }
    }

    const lower = instructionText.toLowerCase()
    const keywords = [...new Set((Array.isArray(options.keywords) ? options.keywords : [])
        .map(item => String(item || '').trim().toLowerCase())
        .filter(Boolean))]
    const matchedKeyword = keywords.find(keyword => lower.includes(keyword)) || ''
    if (matchedKeyword) {
        if (isReferentialBotKeywordMention(instructionText, matchedKeyword)) {
            return { triggered: false, reason: 'keyword_reference', matchedKeyword, forceReadCurrentImages: shouldReadCurrentImages }
        }
        return { triggered: true, reason: 'keyword', matchedKeyword, forceReadCurrentImages: shouldReadCurrentImages }
    }

    return { triggered: false, reason: 'none', forceReadCurrentImages: shouldReadCurrentImages }
}

export function resolveFastChatImageDelivery(imageCount = 0, directLimit = 4) {
    const count = Math.max(0, Math.floor(Number(imageCount) || 0))
    const limit = Math.max(1, Math.floor(Number(directLimit) || 4))
    if (count === 0) return 'none'
    return count <= limit ? 'direct' : 'batch'
}

export function getPureImageReplyPolicy() {
    return `- 本轮当前消息只有图片，并且另有 @机器人等正常回复触发条件。把图片当作一句自然的群聊表达，默认只用 1 至 2 句简短回应；表情包优先回应它传达的情绪、梗或反应，不要逐项复述画面。
- 用户没有提出问题时，不要称呼发送者昵称，不要猜测发送动机、现实状态或接下来要做什么，不要主动提及当前时间、作息、健康、学习或工作，更不要劝睡、说教或套用旧记忆。
- 后台会另行生成图片记忆摘要，因此自然回复不承担归档职责；不要为了记录图片而输出客观长描述。看不懂时简短说不确定，或自然问一句即可。`
}
