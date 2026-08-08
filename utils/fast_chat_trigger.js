export function resolveFastChatTrigger(options = {}) {
    if (options.mentionedBot === true) {
        return { triggered: true, reason: 'mentioned_bot', forceReadCurrentImages: false }
    }

    const instructionText = String(options.instructionText || '').trim()
    const currentImageCount = Math.max(0, Math.floor(Number(options.currentImageCount) || 0))
    const imageTrigger = options.triggerOnImage === true
        && currentImageCount > 0
        && !instructionText
    if (imageTrigger) {
        return { triggered: true, reason: 'image_only', forceReadCurrentImages: true }
    }

    const lower = instructionText.toLowerCase()
    const keywords = [...new Set((Array.isArray(options.keywords) ? options.keywords : [])
        .map(item => String(item || '').trim().toLowerCase())
        .filter(Boolean))]
    const matchedKeyword = keywords.find(keyword => lower.includes(keyword)) || ''
    if (matchedKeyword) {
        return { triggered: true, reason: 'keyword', matchedKeyword, forceReadCurrentImages: false }
    }

    return { triggered: false, reason: 'none', forceReadCurrentImages: false }
}

export function resolveFastChatImageDelivery(imageCount = 0, directLimit = 4) {
    const count = Math.max(0, Math.floor(Number(imageCount) || 0))
    const limit = Math.max(1, Math.floor(Number(directLimit) || 4))
    if (count === 0) return 'none'
    return count <= limit ? 'direct' : 'batch'
}
