/**
 * AI-Plugin 工具集入口
 * 使用方法：
 *   import { toolRegistry } from '../tools/index.js'
 */

export { toolRegistry } from './registry.js'
export { webSearchTool } from './search.js'
export { visionRelayTool, relayImagesToVision } from './vision_relay.js'
export { systemInfoTool } from './system_info.js'
export { fileReadTool } from './file_read.js'
export { fileSendTool } from './file_send.js'
export { fileDownloadTool } from './file_download.js'
export { imageGenTool } from './image_gen.js'
export { shellExecTool } from './shell_exec.js'
export { webFetchTool } from './web_fetch.js'
export { weatherTool } from './weather.js'