import sharp from 'sharp'

globalThis.logger = globalThis.logger || { info() {}, warn() {}, error() {}, debug() {} }
const { Config } = await import('../utils/config.js')
const { processImageBufferForAI, processInlineImagesForAI, processImagesInBatches } = await import('../utils/image.js')

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

const forcedJpeg = await processInlineImagesForAI([{ inline_data: { mime_type: 'image/png', data: smallImage.toString('base64') } }], { forceFormat: 'jpeg' })
check('Vision Relay inline 图片强制转 JPEG', forcedJpeg.length === 1 && forcedJpeg[0].inline_data.mime_type === 'image/jpeg')

const batchProcessed = await processImagesInBatches([], { maxImages: 1 })
check('批量图片处理入口正常工作', Array.isArray(batchProcessed) && batchProcessed.length === 0, String(batchProcessed.length))

if (failures.length > 0) {
    console.error(`Image eval: ${passed} passed, ${failures.length} failed`)
    process.exitCode = 1
} else {
    console.log(`Image eval: ${passed} passed, 0 failed`)
}
