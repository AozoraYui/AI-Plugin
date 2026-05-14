import sharp from 'sharp'
import { urlToBuffer, getImageMimeType } from './common.js'
import { Config } from './config.js'

/**
 * 处理单张图片，返回适合发送给 AI 的 inline_data 格式。
 * 自动处理：大小压缩（>MAX_IMAGE_SIZE_MB）、GIF→PNG 转换。
 * 失败时返回 null。
 */
export async function processImageForAI(imageUrl) {
    try {
        let imageBuffer = await urlToBuffer(imageUrl)
        if (!imageBuffer) {
            logger.warn(`[AI-Plugin] 获取图片失败: ${imageUrl}`)
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
 * 分批处理多张图片，返回 inline_data 数组。
 * 自动限制最大图片数量和每批并发数。
 */
export async function processImagesInBatches(imageUrls) {
    const imagesToProcess = imageUrls.slice(0, Config.MAX_IMAGES_PER_MESSAGE)
    const validImages = []

    for (let i = 0; i < imagesToProcess.length; i += Config.IMAGE_PROCESSING_BATCH_SIZE) {
        const batch = imagesToProcess.slice(i, i + Config.IMAGE_PROCESSING_BATCH_SIZE)
        const batchPromises = batch.map(url => processImageForAI(url))
        const batchResults = await Promise.all(batchPromises)
        validImages.push(...batchResults.filter(img => img !== null))
    }

    if (validImages.length < imagesToProcess.length) {
        logger.warn(`[AI-Plugin] ${imagesToProcess.length - validImages.length} 张图片处理失败`)
    }

    return validImages
}
