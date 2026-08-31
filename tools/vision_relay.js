/**
 * 图文转述工具（Vision Relay）
 * 当主模型不支持多模态时，先用 Vision 模型描述图片，
 * 再将描述文本喂给主模型，使非多模态模型也能"看图"。
 */

import { toolRegistry } from './registry.js'
import { processImagesInBatches } from '../utils/image.js'

/**
 * 将图片发送给 Vision 模型，获取详细描述
 * @param {(string|object)[]} imageUrls - 图片 URL 数组，或已经处理好的 inline_data 图片数组
 * @param {string} context - 用户消息上下文
 * @param {object} client - AiClient 实例
 * @param {object} visionModelConfig - { provider_id, model_id }
 * @returns {Promise<string>} 图片描述文本
 */
async function relayImagesToVision(imageUrls, context, client, visionModelConfig) {
    if (!imageUrls?.length) return ''
    if (!visionModelConfig?.provider_id || !visionModelConfig?.model_id) return ''

    logger.info(`[AI-Plugin] Vision Relay: 开始转述 ${imageUrls.length} 张图片`)
    const startTime = Date.now()

    try {
        const inlineImages = imageUrls.filter(img => img?.inline_data?.data)
        const urlImages = imageUrls.filter(img => typeof img === 'string')
        const validImages = [
            ...inlineImages,
            ...(urlImages.length > 0 ? await processImagesInBatches(urlImages) : [])
        ]
        if (validImages.length === 0) {
            logger.warn('[AI-Plugin] Vision Relay: 所有图片处理失败')
            return ''
        }

        const promptText = context
            ? `请按顺序逐一描述以下每张图片。用户附带的消息是：「${context}」。\n\n请按以下格式输出：\n图片#1：[详细描述，包括人物外貌/穿着/表情/动作、场景环境、物体细节、文字内容、颜色、构图等]\n图片#2：[详细描述...]\n...\n\n注意：请严格按照图片的实际顺序，从第一张开始逐一描述，不要跳过任何一张。`
            : `请按顺序逐一描述以下每张图片。\n\n请按以下格式输出：\n图片#1：[详细描述，包括人物外貌/穿着/表情/动作、场景环境、物体细节、文字内容、颜色、构图等]\n图片#2：[详细描述...]\n...\n\n注意：请严格按照图片的实际顺序，从第一张开始逐一描述，不要跳过任何一张。`

        const parts = [{ text: promptText }, ...validImages]

        const payload = {
            contents: [
                { role: 'user', parts }
            ]
        }

        // 找到 vision model 对应的 provider
        const modelConfig = client.resolveModelConfig?.(visionModelConfig.model_id, visionModelConfig.provider_id) || visionModelConfig
        const provider = client.modelsConfig.find(p => p.id === modelConfig.provider_id)
        if (!provider) {
            logger.warn(`[AI-Plugin] Vision Relay: 找不到供应商标识 ${modelConfig.provider_id}`)
            return ''
        }
        const statusKey = `${modelConfig.provider_id}-${modelConfig.id || modelConfig.model_id}`
        client._prepareModelStatusKey?.(statusKey)
        logger.info(`[AI-Plugin] Vision Relay: 调用 ${modelConfig.provider_id}/${modelConfig.model_id}`)

        const timeout = client._resolveRequestTimeout?.('chat', 2048, 'flash') || 90000
        const result = await client.attemptRequest?.(
            'chat',
            payload,
            provider,
            modelConfig.model_id,
            2048,
            timeout,
            modelConfig
        )

        if (result?.success && result.data) {
            client._recordModelSuccess(statusKey, Date.now() - startTime)
            client.saveModelStatus()
            logger.info(`[AI-Plugin] Vision Relay: 转述成功 (${result.data.length} 字符)`)
            return result.data
        } else {
            client._recordModelFail(statusKey)
            client.saveModelStatus()
            logger.warn(`[AI-Plugin] Vision Relay: 请求失败: ${result?.error || '客户端未提供请求结果'}`)
            return ''
        }
    } catch (err) {
        logger.error('[AI-Plugin] Vision Relay 异常:', err)
        return ''
    }
}

export const visionRelayTool = {
    name: 'vision_relay',
    permission: 'all',
    description: '使用 Vision 模型描述图片，再将描述文本传递给主模型。用于非多模态模型间接"看图"。',

    /**
     * 执行图文转述
     * @param {{ images: string[], context?: string, client: object, visionModelConfig: object }} args
     * @returns {{ description: string }}
     */
    async execute(args) {
        const { images, context, client, visionModelConfig } = args
        const description = await relayImagesToVision(images, context, client, visionModelConfig)
        return { description }
    },

    formatResult(data) {
        if (!data?.description) return ''
        return `\n\n【以下是对用户发送图片的详细描述：】\n${data.description}\n【图片描述结束】\n`
    }
}

// 导出 relayImagesToVision 方便 chat.js 直接调用
export { relayImagesToVision }

// 自动注册
toolRegistry.register(visionRelayTool)
