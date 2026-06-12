/**
 * 图文转述工具（Vision Relay）
 * 当主模型不支持多模态时，先用 Vision 模型描述图片，
 * 再将描述文本喂给主模型，使非多模态模型也能"看图"。
 */

import { toolRegistry } from './registry.js'
import { processImagesInBatches } from '../utils/image.js'
import { fetchWithProxy } from '../utils/common.js'

/**
 * 将图片发送给 Vision 模型，获取详细描述
 * @param {string[]} imageUrls - 图片 URL 数组
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
        // 处理图片为 inline_data 格式
        const validImages = await processImagesInBatches(imageUrls)
        if (validImages.length === 0) {
            logger.warn('[AI-Plugin] Vision Relay: 所有图片处理失败')
            return ''
        }

        const parts = [...validImages]
        const promptText = context
            ? `请极尽详细地描述以下图片中的所有内容，包括但不限于：人物外貌/穿着/表情/动作、场景环境、物体细节、文字内容、颜色、构图等。用户附带的消息是：「${context}」，请在描述时注意关联用户意图。`
            : '请极尽详细地描述以下图片中的所有内容，包括但不限于：人物外貌/穿着/表情/动作、场景环境、物体细节、文字内容、颜色、构图等。'

        parts.push({ text: promptText })

        const payload = {
            contents: [
                { role: 'user', parts }
            ]
        }

        // 找到 vision model 对应的 provider
        const provider = client.modelsConfig.find(p => p.id === visionModelConfig.provider_id)
        if (!provider) {
            logger.warn(`[AI-Plugin] Vision Relay: 找不到供应商标识 ${visionModelConfig.provider_id}`)
            return ''
        }

        // 直接调用 provider API
        const request = client.buildRequest('chat', payload, provider, visionModelConfig.model_id, 2048)

        logger.info(`[AI-Plugin] Vision Relay: 调用 ${visionModelConfig.provider_id}/${visionModelConfig.model_id}`)

        const response = await fetchWithProxy(request.url, request.options)

        if (!response.ok) {
            const errBody = await response.text().catch(() => '')
            client._recordModelFail(`${visionModelConfig.provider_id}-${visionModelConfig.model_id}`)
            client.saveModelStatus()
            logger.warn(`[AI-Plugin] Vision Relay: API 返回 ${response.status}: ${errBody.slice(0, 300)}`)
            return ''
        }

        const data = await response.json()
        const description = client.parseResponse(data, 'chat')

        if (description.success && description.data) {
            client._recordModelSuccess(`${visionModelConfig.provider_id}-${visionModelConfig.model_id}`, Date.now() - startTime)
            client.saveModelStatus()
            logger.info(`[AI-Plugin] Vision Relay: 转述成功 (${description.data.length} 字符)`)
            return description.data
        } else {
            client._recordModelFail(`${visionModelConfig.provider_id}-${visionModelConfig.model_id}`)
            client.saveModelStatus()
            logger.warn(`[AI-Plugin] Vision Relay: 解析失败: ${description.error || '未知'}`)
            return ''
        }
    } catch (err) {
        logger.error('[AI-Plugin] Vision Relay 异常:', err)
        return ''
    }
}

export const visionRelayTool = {
    name: 'vision_relay',
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