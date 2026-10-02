import sharp from 'sharp'
import { urlToBuffer, getImageMimeType } from './common.js'
import { Config } from './config.js'

function payloadSizeMB(contents = []) {
    return JSON.stringify({ contents }).length / (1024 * 1024)
}

export function trimInlineImagesToPayloadLimit(contents = [], limitMB = 10, options = {}) {
    const minimumImages = Math.max(0, Math.floor(Number(options.minimumImages) || 0))
    const cloned = (Array.isArray(contents) ? contents : []).map(content => ({
        ...content,
        parts: Array.isArray(content?.parts) ? [...content.parts] : content?.parts
    }))
    const imageRefs = []
    cloned.forEach((content, contentIndex) => {
        if (!Array.isArray(content.parts)) return
        content.parts.forEach((part, partIndex) => {
            if (part?.inline_data?.data) imageRefs.push({ contentIndex, partIndex })
        })
    })

    let removedImages = 0
    let currentSizeMB = payloadSizeMB(cloned)
    while (currentSizeMB > limitMB && imageRefs.length - removedImages > minimumImages) {
        const target = imageRefs[imageRefs.length - 1 - removedImages]
        cloned[target.contentIndex].parts[target.partIndex] = null
        removedImages++
        currentSizeMB = payloadSizeMB(cloned)
    }
    if (removedImages > 0) {
        for (const content of cloned) {
            if (Array.isArray(content.parts)) content.parts = content.parts.filter(Boolean)
        }
        currentSizeMB = payloadSizeMB(cloned)
    }
    return { contents: cloned, removedImages, sizeMB: currentSizeMB }
}

function normalizeForceFormat(value) {
    const format = String(value || '').trim().toLowerCase()
    return ['jpeg', 'png', 'webp'].includes(format) ? format : ''
}

function getImagePixelLimit() {
    const configured = Number(Config.MAX_IMAGE_PIXELS)
    return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 4000000
}

function getImageResizeLimit() {
    const configured = Number(Config.MAX_IMAGE_RESIZE)
    return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 1920
}

function getImageQuality() {
    const configured = Number(Config.IMAGE_QUALITY)
    return Number.isFinite(configured) ? Math.min(Math.max(Math.floor(configured), 1), 100) : 80
}

/**
 * 将图片压缩到视觉模型可接受的尺寸，并在需要时统一为标准图片格式。
 * 不只按文件大小判断：高分辨率 PNG 可能只有几 MB，但仍会超过上游 patch 限制。
 */
export async function processImageBufferForAI(imageBuffer, options = {}) {
    try {
        imageBuffer = Buffer.from(imageBuffer || [])
        if (imageBuffer.length === 0) {
            logger.warn('[AI-Plugin] 图片内容为空')
            return null
        }

        const metadata = await sharp(imageBuffer).metadata()
        const width = Number(metadata.width) || 0
        const height = Number(metadata.height) || 0
        const pixels = width > 0 && height > 0 ? width * height : 0
        const sizeMB = imageBuffer.length / (1024 * 1024)
        const maxPixels = getImagePixelLimit()
        const maxEdge = getImageResizeLimit()
        const maxSizeMB = Number(Config.MAX_IMAGE_SIZE_MB) > 0 ? Number(Config.MAX_IMAGE_SIZE_MB) : 4
        const forceFormat = normalizeForceFormat(options.forceFormat)
        const sourceFormat = String(metadata.format || '').toLowerCase()
        const supportedFormat = ['jpeg', 'png', 'webp', 'gif'].includes(sourceFormat)
        const needsResize = width > maxEdge || height > maxEdge || pixels > maxPixels
        const needsSizeCompression = sizeMB > maxSizeMB
        const needsFormatNormalization = Boolean(forceFormat) || !supportedFormat
        const shouldTransform = needsResize || needsSizeCompression || needsFormatNormalization || sourceFormat === 'gif'
        const pixelScale = pixels > maxPixels && pixels > 0
            ? Math.sqrt(maxPixels / pixels)
            : 1
        const resizeWidth = width > 0 ? Math.max(1, Math.floor(Math.min(width, maxEdge, width * pixelScale))) : maxEdge
        const resizeHeight = height > 0 ? Math.max(1, Math.floor(Math.min(height, maxEdge, height * pixelScale))) : maxEdge

        let finalBuffer = imageBuffer
        let mimeType = getImageMimeType(imageBuffer)
        if (shouldTransform) {
            const reasons = []
            if (needsResize) reasons.push(`尺寸${width}x${height}/${pixels || '?'}像素`)
            if (needsSizeCompression) reasons.push(`${sizeMB.toFixed(2)}MB`)
            if (needsFormatNormalization) reasons.push(`格式${sourceFormat || '未知'}→${forceFormat || 'jpeg'}`)
            logger.info(`[AI-Plugin] 图片预处理: ${reasons.join('、') || '标准化'}`)

            let pipeline = sharp(imageBuffer).rotate()
            if (needsResize || needsSizeCompression) {
                pipeline = pipeline.resize({
                    width: resizeWidth,
                    height: resizeHeight,
                    fit: 'inside',
                    withoutEnlargement: true
                })
            }
            const outputFormat = forceFormat || (sourceFormat === 'gif' ? 'png' : 'jpeg')
            if (outputFormat === 'jpeg') {
                pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: getImageQuality(), mozjpeg: true })
                mimeType = 'image/jpeg'
            } else if (outputFormat === 'png') {
                pipeline = pipeline.png()
                mimeType = 'image/png'
            } else {
                pipeline = pipeline.webp({ quality: getImageQuality() })
                mimeType = 'image/webp'
            }
            finalBuffer = await pipeline.toBuffer()
        }

        if (!mimeType || !['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
            const normalized = await sharp(finalBuffer)
                .rotate()
                .resize({ width: resizeWidth, height: resizeHeight, fit: 'inside', withoutEnlargement: true })
                .flatten({ background: '#ffffff' })
                .jpeg({ quality: getImageQuality(), mozjpeg: true })
                .toBuffer()
            finalBuffer = normalized
            mimeType = 'image/jpeg'
        }

        return {
            inline_data: {
                mime_type: mimeType,
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
 */
export async function processImageForAI(imageUrl, options = {}) {
    try {
        const imageBuffer = await urlToBuffer(imageUrl)
        if (!imageBuffer) {
            logger.warn(`[AI-Plugin] 获取图片失败: ${imageUrl}`)
            return null
        }
        return await processImageBufferForAI(imageBuffer, options)
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
 * 重新处理已有 inline_data 图片，供 Vision Relay 等严格接口统一格式。
 */
export async function processInlineImagesForAI(imageParts, options = {}) {
    const parts = Array.isArray(imageParts) ? imageParts : []
    const results = await Promise.all(parts.map(async part => {
        const data = part?.inline_data?.data
        if (!data) return null
        try {
            return await processImageBufferForAI(Buffer.from(String(data), 'base64'), options)
        } catch (err) {
            logger.warn(`[AI-Plugin] inline 图片处理异常: ${err.message}`)
            return null
        }
    }))
    return results.filter(Boolean)
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
        const batchPromises = batch.map(url => processImageForAI(url, options))
        const batchResults = await Promise.all(batchPromises)
        validImages.push(...batchResults.filter(img => img !== null))
    }

    if (validImages.length < imagesToProcess.length) {
        logger.warn(`[AI-Plugin] ${imagesToProcess.length - validImages.length} 张图片处理失败`)
    }

    return validImages
}
