import { pluginLogger as logger } from './plugin_logger.js'
import sharp from 'sharp'
import { isAbortError, throwIfAborted, urlToBuffer, getImageMimeType } from './common.js'
import { Config } from './config.js'

export function estimatePayloadSizeBytes(contents = []) {
    return Buffer.byteLength(JSON.stringify({ contents }), 'utf8')
}

function payloadSizeMB(contents = []) {
    return estimatePayloadSizeBytes(contents) / (1024 * 1024)
}

export function deduplicateImageUrls(imageUrls = []) {
    const seen = new Set()
    const images = []
    let duplicatesRemoved = 0
    for (const imageUrl of Array.isArray(imageUrls) ? imageUrls : []) {
        const key = String(imageUrl || '').trim()
        if (!key) continue
        if (seen.has(key)) {
            duplicatesRemoved++
            continue
        }
        seen.add(key)
        images.push(imageUrl)
    }
    return { images, duplicatesRemoved }
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

    let latestUserTurnIndex = -1
    for (let index = cloned.length - 1; index >= 0; index--) {
        if (cloned[index]?.role === 'user' && Array.isArray(cloned[index]?.parts)) {
            latestUserTurnIndex = index
            break
        }
    }
    imageRefs.sort((left, right) => {
        const leftIsCurrent = left.contentIndex === latestUserTurnIndex
        const rightIsCurrent = right.contentIndex === latestUserTurnIndex
        if (leftIsCurrent !== rightIsCurrent) return leftIsCurrent ? 1 : -1
        if (leftIsCurrent) return right.partIndex - left.partIndex
        return left.contentIndex - right.contentIndex || left.partIndex - right.partIndex
    })

    let removedImages = 0
    let currentSizeMB = payloadSizeMB(cloned)
    while (currentSizeMB > limitMB && imageRefs.length - removedImages > minimumImages) {
        const target = imageRefs[removedImages]
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
    return {
        contents: cloned,
        removedImages,
        sizeBytes: estimatePayloadSizeBytes(cloned),
        sizeMB: currentSizeMB
    }
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

export const MAX_GIF_REVIEW_FRAMES = 256
const MAX_GIF_CONTACT_SHEET_EDGE = 1920
const MAX_GIF_REVIEW_FRAME_SIZE = 256

function normalizeGifDelay(value) {
    const delay = Number(value)
    return Number.isFinite(delay) && delay >= 0 ? Math.floor(delay) : null
}

export function getGifAnimationMetadata(metadata = {}) {
    const frameCount = Math.max(0, Math.floor(Number(metadata.pages) || 0))
    const rawDelays = Array.isArray(metadata.delay)
        ? metadata.delay
        : frameCount > 0
            ? Array.from({ length: frameCount }, () => metadata.delay)
            : []
    const frameDelaysMs = rawDelays.map(normalizeGifDelay)
    const hasFrameTiming = frameCount > 0 && frameDelaysMs.length === frameCount && frameDelaysMs.every(delay => delay !== null)
    const totalDurationMs = hasFrameTiming
        ? frameDelaysMs.reduce((total, delay) => total + delay, 0)
        : null
    return {
        frame_count: frameCount,
        total_duration_ms: totalDurationMs,
        has_frame_timing: hasFrameTiming,
        has_variable_frame_duration: hasFrameTiming && new Set(frameDelaysMs).size > 1
    }
}

export function selectGifReviewFrameIndexes(pageCount) {
    const totalFrames = Math.max(0, Math.floor(Number(pageCount) || 0))
    if (totalFrames > MAX_GIF_REVIEW_FRAMES) {
        throw new Error(`GIF 动画超过安全审核帧数上限 (${MAX_GIF_REVIEW_FRAMES})`)
    }
    return Array.from({ length: totalFrames }, (_, index) => index)
}

async function buildGifContactSheet(imageBuffer, pageCount, options = {}) {
    const indexes = selectGifReviewFrameIndexes(pageCount)
    const columns = Math.ceil(Math.sqrt(indexes.length))
    const rows = Math.ceil(indexes.length / columns)
    const frameSize = Math.max(1, Math.min(
        MAX_GIF_REVIEW_FRAME_SIZE,
        Math.floor(MAX_GIF_CONTACT_SHEET_EDGE / columns),
        Math.floor(MAX_GIF_CONTACT_SHEET_EDGE / rows)
    ))
    const frames = []
    for (const page of indexes) {
        throwIfAborted(options.signal)
        frames.push(await sharp(imageBuffer, { page })
            .rotate()
            .resize(frameSize, frameSize, { fit: 'contain', background: '#ffffff' })
            .png()
            .toBuffer())
    }
    return sharp({
        create: {
            width: frameSize * columns,
            height: frameSize * rows,
            channels: 3,
            background: '#ffffff'
        }
    }).composite(frames.map((input, index) => ({
        input,
        left: (index % columns) * frameSize,
        top: Math.floor(index / columns) * frameSize
    }))).png().toBuffer()
}

/**
 * 将图片压缩到视觉模型可接受的尺寸，并在需要时统一为标准图片格式。
 * 不只按文件大小判断：高分辨率 PNG 可能只有几 MB，但仍会超过上游 patch 限制。
 */
export async function processImageBufferForAI(imageBuffer, options = {}) {
    try {
        throwIfAborted(options.signal)
        imageBuffer = Buffer.from(imageBuffer || [])
        if (imageBuffer.length === 0) {
            logger.warn('[AI-Plugin] 图片内容为空')
            return null
        }

        const metadata = await sharp(imageBuffer).metadata()
        throwIfAborted(options.signal)
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
        const preserveAnimation = options.preserveAnimation === true && sourceFormat === 'gif' && Number(metadata.pages) > 1
        const pixelScale = pixels > maxPixels && pixels > 0
            ? Math.sqrt(maxPixels / pixels)
            : 1
        const resizeWidth = width > 0 ? Math.max(1, Math.floor(Math.min(width, maxEdge, width * pixelScale))) : maxEdge
        const resizeHeight = height > 0 ? Math.max(1, Math.floor(Math.min(height, maxEdge, height * pixelScale))) : maxEdge

        if (preserveAnimation) {
            const animationPipeline = sharp(imageBuffer, { animated: true }).rotate()
            if (needsResize || needsSizeCompression) {
                animationPipeline.resize({
                    width: resizeWidth,
                    height: resizeHeight,
                    fit: 'inside',
                    withoutEnlargement: true
                })
            }
            const gifOutputOptions = {}
            if (Array.isArray(metadata.delay) && metadata.delay.length > 0) gifOutputOptions.delay = metadata.delay
            if (Number.isFinite(Number(metadata.loop))) gifOutputOptions.loop = Number(metadata.loop)
            const animatedBuffer = needsResize || needsSizeCompression
                ? await animationPipeline.gif(gifOutputOptions).toBuffer()
                : imageBuffer
            const fallbackBuffer = await buildGifContactSheet(imageBuffer, Number(metadata.pages), options)
            return {
                inline_data: {
                    mime_type: 'image/gif',
                    data: animatedBuffer.toString('base64')
                },
                fallback_inline_data: {
                    mime_type: 'image/png',
                    data: fallbackBuffer.toString('base64')
                },
                gif_metadata: getGifAnimationMetadata(metadata)
            }
        }

        const shouldTransform = needsResize || needsSizeCompression || needsFormatNormalization || sourceFormat === 'gif'

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
            throwIfAborted(options.signal)
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
        if (isAbortError(err, options.signal)) throw err
        logger.warn(`[AI-Plugin] 图片处理异常: ${err.message}`)
        return null
    }
}

export function isAnimatedImageRequested(text = '') {
    const value = String(text || '')
    if (!value) return false
    if (/(?:不要|不需要|无需|别|不用|禁止|取消)\s*(?:做成|生成|做|输出|制作|转成|变成)?\s*(?:动图|动态图|gif|动画图|动画效果)|(?:don't|do not|no need to)\s*(?:make|create|generate|output|turn|convert)?\s*(?:it|this|the image|an? image)?\s*(?:a[n]?\s+)?(?:gif|animation|animated)/i.test(value)) return false
    if (/(?:gif|动图|动态图|动画图|动画效果)/i.test(value)) return true
    if (/(?:做成|生成|输出|制作|转成|变成|转换为)\s*(?:动态(?:图)?|动画(?:图|效果)?)|让.{0,12}动起来|(?:添加|加入|制作).{0,12}动画效果/i.test(value)) return true
    return /(?:\b(?:make|create|generate|turn|convert)\b[\s\S]{0,24}\b(?:animated gif|gif|animation|animated)\b(?!\s+(?:character|style|scene|movie|series|film|art|illustration))|\banimate\s+(?:this|it|the image|the picture)\b|\b(?:make this|make it|turn this|convert this)\b[\s\S]{0,15}\b(?:animated|move|moving)\b)/i.test(value)
}

/**
 * 处理单张图片 URL，返回适合发送给 AI 的 inline_data 格式。
 */
export async function processImageForAI(imageUrl, options = {}) {
    try {
        throwIfAborted(options.signal)
        const imageBuffer = await urlToBuffer(imageUrl, { signal: options.signal })
        if (!imageBuffer) {
            logger.warn(`[AI-Plugin] 获取图片失败: ${imageUrl}`)
            return null
        }
        return await processImageBufferForAI(imageBuffer, options)
    } catch (err) {
        if (isAbortError(err, options.signal)) throw err
        logger.warn(`[AI-Plugin] 图片处理异常: ${err.message}`)
        return null
    }
}

export function normalizeImageLimit(value, fallback) {
    if (value === Infinity) return Infinity
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase()
        if (['unlimited', 'infinite', 'infinity', 'inf', 'all', 'no_limit', 'nolimit', '无限', '不限', '不限制', '全部', '所有'].includes(normalized)) return Infinity
    }
    const num = Number(value)
    if (num === Infinity || num === -Infinity || num < 0) return Infinity
    return Number.isFinite(num) && num >= 0 ? Math.floor(num) : fallback
}

/**
 * 重新处理已有 inline_data 图片，供 Vision Relay 等严格接口统一格式。
 */
export async function processInlineImagesForAI(imageParts, options = {}) {
    const parts = Array.isArray(imageParts) ? imageParts : []
    throwIfAborted(options.signal)
    const results = await Promise.all(parts.map(async part => {
        const data = part?.inline_data?.data
        if (!data) return null
        try {
            throwIfAborted(options.signal)
            return await processImageBufferForAI(Buffer.from(String(data), 'base64'), options)
        } catch (err) {
            if (isAbortError(err, options.signal)) throw err
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
    throwIfAborted(options.signal)
    const maxImages = normalizeImageLimit(options.maxImages, Config.MAX_IMAGES_PER_MESSAGE)
    const imagesToProcess = maxImages === Infinity ? imageUrls.slice() : imageUrls.slice(0, maxImages)
    const processingBatchSize = Math.max(1, Number(Config.IMAGE_PROCESSING_BATCH_SIZE) || 1)
    const validImages = []

    for (let i = 0; i < imagesToProcess.length; i += processingBatchSize) {
        throwIfAborted(options.signal)
        const batch = imagesToProcess.slice(i, i + processingBatchSize)
        const batchPromises = batch.map(url => processImageForAI(url, options))
        const batchResults = await Promise.all(batchPromises)
        throwIfAborted(options.signal)
        validImages.push(...batchResults.filter(img => img !== null))
    }

    if (validImages.length < imagesToProcess.length) {
        logger.warn(`[AI-Plugin] ${imagesToProcess.length - validImages.length} 张图片处理失败`)
    }

    return validImages
}
