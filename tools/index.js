/**
 * AI-Plugin 工具集入口
 * 使用方法：
 *   import { toolRegistry } from '../tools/index.js'
 */

export { toolRegistry } from './registry.js'
export { webSearchTool } from './search.js'
export { visionRelayTool, relayImagesToVision } from './vision_relay.js'
export { systemInfoTool } from './system_info.js'