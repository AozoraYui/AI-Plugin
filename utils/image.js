import sharp from 'sharp'
import { urlToBuffer, getImageMimeType } from './common.js'
import { Config } from './config.js'

export async function processImageBufferForAI(imageBuffer) {
    try {
        imageBuffer = Buffer.from(imageBuffer)
        if (!imageBuffer) {
            logger.warn('[AI-Plugin] 图片内容为空')
            return null
        }

        const sizeMB = imageBuffer.length / (1024 * 1024)
        if (sizeMB > Config.MAX_IMAGE_SIZE_MB) {
            logger.warn(`[AI-Plugin] 图片过大 (${sizeMB.toFixed(2)}MB)，正在压缩...`)
            imageBuffer = await sharp(imageBuffer)
                .resize(Config.MAX_IMAGE_RESIZE, Config.MAX_IMAGE_RESIZE, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: Config.IMAGE_QUALITY })
                .toBuffer()
        }

        let mimeType = getImageMimeType(imageBuffer)
        let finalBuffer = imageBuffer

        if (mimeType === 'image/gif') {
            finalBuffer = await sharp(imageBuffer).toFormat('png').toBuffer()
            mimeType = 'image/png'
        }

        return {
            inline_data: {
                mime_type: mimeType || 'image/jpeg',
                data: finalBuffer.toString('base64')
            }
        }
    } catch (err) {
        logger.warn(`[AI-Plugin] 图片处理异常: ${err.message}`)
        return null
    }
}

/**
 * 处理单张图片 URL，返回适合发送给 AI 的 inline_data 格式。
 * 自动处理：大小压缩（>MAX_IMAGE_SIZE_MB）、GIF→PNG 转换。
 * 失败时返回 null。
 */
export async function processImageForAI(imageUrl) {
    try {
        const imageBuffer = await urlToBuffer(imageUrl)
        if (!imageBuffer) {
            logger.warn(`[AI-Plugin] 获取图片失败: ${imageUrl}`)
            return null
        }
        return await processImageBufferForAI(imageBuffer)
    } catch (err) {
        logger.warn(`[AI-Plugin] 图片处理异常: ${err.message}`)
        return null
    }
}

function normalizeImageLimit(value, fallback) {
    if (value === Infinity) return Infinity
    const num = Number(value)
    if (num === Infinity) return Infinity
    return Number.isFinite(num) && num >= 0 ? Math.floor(num) : fallback
}

/**
 * 分批处理多张图片，返回 inline_data 数组。
 * 默认限制最大图片数量；调用方可传入 maxImages 覆盖数量限制。
 */
export async function processImagesInBatches(imageUrls, options = {}) {
    const maxImages = normalizeImageLimit(options.maxImages, Config.MAX_IMAGES_PER_MESSAGE)
    const imagesToProcess = maxImages === Infinity ? imageUrls.slice() : imageUrls.slice(0, maxImages)
    const processingBatchSize = Math.max(1, Number(Config.IMAGE_PROCESSING_BATCH_SIZE) || 1)
    const validImages = []

    for (let i = 0; i < imagesToProcess.length; i += processingBatchSize) {
        const batch = imagesToProcess.slice(i, i + processingBatchSize)
        const batchPromises = batch.map(url => processImageForAI(url))
        const batchResults = await Promise.all(batchPromises)
        validImages.push(...batchResults.filter(img => img !== null))
    }

    if (validImages.length < imagesToProcess.length) {
        logger.warn(`[AI-Plugin] ${imagesToProcess.length - validImages.length} 张图片处理失败`)
    }

    return validImages
}
