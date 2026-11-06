import sharp from 'sharp'
import fs from 'node:fs'

globalThis.logger = globalThis.logger || { info() {}, warn() {}, error() {}, debug() {} }
const { Config } = await import('../utils/config.js')
const { deduplicateImageUrls, estimatePayloadSizeBytes, getGifAnimationMetadata, isAnimatedImageRequested, normalizeImageLimit, processImageBufferForAI, processInlineImagesForAI, processImagesInBatches, selectGifReviewFrameIndexes, trimInlineImagesToPayloadLimit } = await import('../utils/image.js')
const { relayImagesToVisionInBatches } = await import('../tools/vision_relay.js')
const { urlToBuffer } = await import('../utils/common.js')

const failures = []
let passed = 0
function check(name, condition, detail = '') {
    if (condition) {
        passed++
        console.log(`PASS ${name}`)
    } else {
        failures.push({ name, detail })
        console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`)
    }
}

const largeImage = await sharp({
    create: { width: 5000, height: 3000, channels: 3, background: { r: 220, g: 240, b: 255 } }
}).png().toBuffer()
const processedLarge = await processImageBufferForAI(largeImage)
const largeBuffer = Buffer.from(processedLarge?.inline_data?.data || '', 'base64')
const largeMetadata = await sharp(largeBuffer).metadata()
const largePixels = Number(largeMetadata.width || 0) * Number(largeMetadata.height || 0)
check('高分辨率小文件按像素预算压缩', Boolean(processedLarge) && largePixels <= Number(Config.MAX_IMAGE_PIXELS), `${largeMetadata.width}x${largeMetadata.height}`)
check('高分辨率图片输出标准格式', processedLarge?.inline_data?.mime_type === 'image/jpeg', processedLarge?.inline_data?.mime_type)
check('高分辨率图片最长边受限', Math.max(largeMetadata.width || 0, largeMetadata.height || 0) <= Number(Config.MAX_IMAGE_RESIZE), `${largeMetadata.width}x${largeMetadata.height}`)

const originalResize = Config.MAX_IMAGE_RESIZE
const originalPixels = Config.MAX_IMAGE_PIXELS
Config.MAX_IMAGE_RESIZE = 4096
Config.MAX_IMAGE_PIXELS = 1000000
const constrained = await processImageBufferForAI(largeImage)
const constrainedBuffer = Buffer.from(constrained?.inline_data?.data || '', 'base64')
const constrainedMetadata = await sharp(constrainedBuffer).metadata()
const constrainedPixels = Number(constrainedMetadata.width || 0) * Number(constrainedMetadata.height || 0)
Config.MAX_IMAGE_RESIZE = originalResize
Config.MAX_IMAGE_PIXELS = originalPixels
check('自定义最长边较大时仍遵守像素上限', constrainedPixels <= 1000000, `${constrainedMetadata.width}x${constrainedMetadata.height}`)

const smallImage = await sharp({
    create: { width: 320, height: 240, channels: 3, background: { r: 255, g: 255, b: 255 } }
}).png().toBuffer()
const smallProcessed = await processImageBufferForAI(smallImage)
check('普通小图片保持可用 PNG', smallProcessed?.inline_data?.mime_type === 'image/png', smallProcessed?.inline_data?.mime_type)

const animatedGif = Buffer.from(fs.readFileSync(new URL('./fixtures/animated.gif.b64', import.meta.url), 'utf8').trim(), 'base64')
const preservedGif = await processImageBufferForAI(animatedGif, { preserveAnimation: true })
const preservedGifMetadata = await sharp(Buffer.from(preservedGif?.inline_data?.data || '', 'base64')).metadata()
const gifFallbackMetadata = await sharp(Buffer.from(preservedGif?.fallback_inline_data?.data || '', 'base64')).metadata()
check('GIF 参考图保留动画并提供安全审核用关键帧拼图', preservedGif?.inline_data?.mime_type === 'image/gif' && preservedGifMetadata.pages === 2 && preservedGif?.fallback_inline_data?.mime_type === 'image/png' && gifFallbackMetadata.width === 512)
check('GIF 元数据保留原始帧数与总时长', preservedGif?.gif_metadata?.frame_count === 2 && preservedGif.gif_metadata.total_duration_ms === 2000 && preservedGif.gif_metadata.has_frame_timing)
const variableTimingMetadata = getGifAnimationMetadata({ pages: 4, delay: [50, 100, 100, 250] })
check('变速 GIF 元数据能识别完整时序与变化帧长', variableTimingMetadata.frame_count === 4 && variableTimingMetadata.total_duration_ms === 500 && variableTimingMetadata.has_variable_frame_duration)
const incompleteTimingMetadata = getGifAnimationMetadata({ pages: 3, delay: [100, 100] })
const zeroDelayMetadata = getGifAnimationMetadata({ pages: 2, delay: [0, 100] })
check('零延时 GIF 仍保留时序信息', zeroDelayMetadata.total_duration_ms === 100 && zeroDelayMetadata.has_frame_timing)
check('不完整的 GIF 时序元数据不被误当成完整总时长', incompleteTimingMetadata.total_duration_ms === null && !incompleteTimingMetadata.has_frame_timing)
const highFrameGif = Buffer.from(fs.readFileSync(new URL('./fixtures/animated-40.gif.b64', import.meta.url), 'utf8').trim(), 'base64')
const preservedHighFrameGif = await processImageBufferForAI(highFrameGif, { preserveAnimation: true })
const preservedHighFrameGifMetadata = await sharp(Buffer.from(preservedHighFrameGif?.inline_data?.data || '', 'base64')).metadata()
const highFrameGifFallbackMetadata = await sharp(Buffer.from(preservedHighFrameGif?.fallback_inline_data?.data || '', 'base64')).metadata()
check('高帧数 GIF 保留原动画并生成全帧审核拼图', preservedHighFrameGif?.inline_data?.mime_type === 'image/gif' && preservedHighFrameGifMetadata.pages === 40 && preservedHighFrameGif?.fallback_inline_data?.mime_type === 'image/png' && highFrameGifFallbackMetadata.width === 1792 && highFrameGifFallbackMetadata.height === 1536)
check('高帧数 GIF 元数据保留完整总时长', preservedHighFrameGif?.gif_metadata?.frame_count === 40 && preservedHighFrameGif.gif_metadata.total_duration_ms === 4000)
const allGifReviewFrames = selectGifReviewFrameIndexes(40)
check('高帧数 GIF 审核包含全部帧', allGifReviewFrames.length === 40 && allGifReviewFrames[0] === 0 && allGifReviewFrames.at(-1) === 39 && allGifReviewFrames.every((frame, index) => frame === index))
let excessiveGifFramesRejected = false
try { selectGifReviewFrameIndexes(257) } catch { excessiveGifFramesRejected = true }
check('超出资源保护上限的 GIF 仍 fail-closed', excessiveGifFramesRejected)
check('自然语言动图意图识别支持中英文', isAnimatedImageRequested('把这张图做成 GIF 动图') && isAnimatedImageRequested('make it animated'))
check('动图意图识别尊重具体否定并保留其他约束', !isAnimatedImageRequested('不要做成动图') && isAnimatedImageRequested('不要改变背景，做成动图'))
check('普通动画题材不会误触发 GIF 输出', !isAnimatedImageRequested('画一个动画角色') && !isAnimatedImageRequested('create an animation character'))

const forcedJpeg = await processInlineImagesForAI([{ inline_data: { mime_type: 'image/png', data: smallImage.toString('base64') } }], { forceFormat: 'jpeg' })
check('Vision Relay inline 图片强制转 JPEG', forcedJpeg.length === 1 && forcedJpeg[0].inline_data.mime_type === 'image/jpeg')

const batchProcessed = await processImagesInBatches([], { maxImages: 1 })
check('批量图片处理入口正常工作', Array.isArray(batchProcessed) && batchProcessed.length === 0, String(batchProcessed.length))

const cancelledImageController = new AbortController()
cancelledImageController.abort()
let batchCancellationCode = ''
try {
    await processImagesInBatches(['https://example.invalid/image.png'], { signal: cancelledImageController.signal })
} catch (error) {
    batchCancellationCode = error.code
}
check('图片分批处理会在已取消时停止，不再下载图片', batchCancellationCode === 'AGENT_CANCELLED', batchCancellationCode)

let downloadCancellationCode = ''
try {
    await urlToBuffer('https://example.invalid/image.png', { signal: cancelledImageController.signal })
} catch (error) {
    downloadCancellationCode = error.code
}
check('图片下载支持取消信号并在发起网络请求前中止', downloadCancellationCode === 'AGENT_CANCELLED', downloadCancellationCode)

const utf8Payload = [{ role: 'user', parts: [{ text: '图片分析' }] }]
check('请求体大小按 UTF-8 字节计算', estimatePayloadSizeBytes(utf8Payload) === Buffer.byteLength(JSON.stringify({ contents: utf8Payload }), 'utf8'))
const deduplicated = deduplicateImageUrls(['https://example.com/a.png', ' https://example.com/a.png ', '', null, 'https://example.com/b.png'])
check('重复图片 URL 去重且不把空值计作重复', deduplicated.images.length === 2 && deduplicated.duplicatesRemoved === 1)
check('图片数量上限接受 unlimited 配置', normalizeImageLimit('unlimited', 100) === Infinity)
const priorTurn = { role: 'user', parts: [{ text: '旧图' }, { inline_data: { mime_type: 'image/png', data: 'a'.repeat(600) } }] }
const latestTurn = { role: 'user', parts: [{ text: '当前图' }, { inline_data: { mime_type: 'image/png', data: 'b'.repeat(700) } }] }
const historyWithImages = [priorTurn, { role: 'model', parts: [{ text: '已看到旧图' }] }, latestTurn]
const currentOnly = [priorTurn, { role: 'model', parts: [{ text: '已看到旧图' }] }, { ...latestTurn, parts: [latestTurn.parts[0]] }]
const currentOnlySizeMB = estimatePayloadSizeBytes(currentOnly) / (1024 * 1024)
const trimmedPayload = trimInlineImagesToPayloadLimit(historyWithImages, currentOnlySizeMB, { minimumImages: 1 })
check('请求体裁剪优先移除历史图片并保留当前图片', trimmedPayload.removedImages === 1 && !trimmedPayload.contents[0].parts.some(part => part?.inline_data) && trimmedPayload.contents[2].parts.some(part => part?.inline_data))
const zeroImagePayload = trimInlineImagesToPayloadLimit(historyWithImages, 0, { minimumImages: 0 })
check('硬请求体预算允许裁掉最后一张超限图片', zeroImagePayload.removedImages === 2 && zeroImagePayload.contents.every(content => !content.parts?.some(part => part?.inline_data)))

const visionBatchPayloads = []
let visionRequestNumber = 0
const mockVisionClient = {
    modelsConfig: [{ id: 'vision-provider' }],
    getVisionRelayModels: () => [{ provider_id: 'vision-provider', model_id: 'vision-model' }],
    async attemptRequest(_type, payload) {
        visionBatchPayloads.push(payload)
        visionRequestNumber++
        return { success: true, data: '可见画面摘要 ' + visionRequestNumber }
    },
    _recordModelSuccess() {},
    saveModelStatus() {}
}
const relayBatchResult = await relayImagesToVisionInBatches(
    Array.from({ length: 6 }, () => ({ inline_data: { mime_type: 'image/png', data: smallImage.toString('base64') } })),
    '分析这些图片',
    mockVisionClient,
    { batchSize: 2, startIndex: 2, concurrency: 1 }
)
const relayBatchPrompts = visionBatchPayloads.map(payload => payload.contents[0].parts[0].text)
check('Vision Relay 分批摘要不漏图并保留原始图片序号', relayBatchResult.processedCount === 6 && relayBatchResult.failedImages.length === 0 && relayBatchResult.summaries.length === 3 && relayBatchPrompts[0].includes('原始序号 3-4') && relayBatchPrompts[2].includes('原始序号 7-8'))
const partialRelayResult = await relayImagesToVisionInBatches(
    [
        { inline_data: { mime_type: 'image/png', data: smallImage.toString('base64') } },
        { inline_data: { mime_type: 'image/png', data: 'not-an-image' } }
    ],
    '分析这两张图片',
    mockVisionClient,
    { batchSize: 2, concurrency: 1 }
)
check('Vision Relay 单批部分图片处理失败时不伪造完整摘要', partialRelayResult.processedCount === 0 && partialRelayResult.failedImages.length === 2 && partialRelayResult.summaries.length === 0)

if (failures.length > 0) {
    console.error(`Image eval: ${passed} passed, ${failures.length} failed`)
    process.exitCode = 1
} else {
    console.log(`Image eval: ${passed} passed, 0 failed`)
}
