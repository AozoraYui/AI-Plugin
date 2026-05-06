import fs from 'node:fs'
import { Config, HISTORY_DIR } from './utils/config.js'
import { AiClient } from './client/AiClient.js'
import { ConversationManager } from './model/conversation.js'
import { AIScheduler } from './utils/scheduler.js'

logger.info('**************************************')
logger.info(`
 ░▒▓██████▓▒░░▒▓█▓▒░      ░▒▓███████▓▒░░▒▓█▓▒░     ░▒▓█▓▒░░▒▓█▓▒░░▒▓██████▓▒░░▒▓█▓▒░▒▓███████▓▒░
░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░     ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░
░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░     ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░
░▒▓████████▓▒░▒▓█▓▒░      ░▒▓███████▓▒░░▒▓█▓▒░     ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒▒▓███▓▒░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░
░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░      ░▒▓█▓▒░     ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░
░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░      ░▒▓█▓▒░     ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░
░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░      ░▒▓████████▓▒░▒▓██████▓▒░ ░▒▓██████▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░
`)
logger.info('AI-Plugin加载中')

if (!global.segment) {
    try {
        global.segment = (await import('icqq')).segment
    } catch (err) {
        global.segment = (await import('oicq')).segment
    }
}

global.AIPluginClient = new AiClient()
global.AIPluginConversationManager = new ConversationManager()
await global.AIPluginConversationManager.waitForMigration()

// 检查是否需要修复迁移日期
const migrationStatus = await global.AIPluginConversationManager.db.getMigrationStatus()
if (migrationStatus.json_migrated) {
    // 检查数据库中是否有日期为今天的数据（说明是错误迁移的）
    const today = new Date().toISOString().split('T')[0]
    const todayCount = await new Promise((resolve, reject) => {
        global.AIPluginConversationManager.db.db.get(
            'SELECT COUNT(*) as count FROM user_histories WHERE date_str = ?',
            [today],
            (err, row) => err ? reject(err) : resolve(row.count)
        )
    })
    
    // 如果今天的数据超过 100 条，说明是错误迁移的（正常一天不会有这么多对话）
    if (todayCount > 100) {
        logger.warn('[AI-Plugin] 检测到迁移日期错误，开始修复...')
        await global.AIPluginConversationManager.fixMigrationDates()
    }
}

global.AIPluginScheduler = new AIScheduler(global.AIPluginClient)
global.AIPluginScheduler.start()

const files = fs.readdirSync('./plugins/AI-Plugin/apps').filter(file => file.endsWith('.js'))

let ret = []

files.forEach((file) => {
    ret.push(import(`./apps/${file}`))
})

ret = await Promise.allSettled(ret)

let apps = {}
for (let i in files) {
    let name = files[i].replace('.js', '')
    if (ret[i].status !== 'fulfilled') {
        logger.error(`载入插件错误：${logger.red(name)}`)
        logger.error(ret[i].reason)
        continue
    }
    const moduleExports = ret[i].value
    for (const key in moduleExports) {
        const exportItem = moduleExports[key]
        if (typeof exportItem === 'function' && exportItem.prototype) {
            apps[key] = exportItem
        }
    }
}

logger.info('AI-Plugin加载成功')
logger.info(`当前版本${Config.version}`)
logger.info('**************************************')

export { apps }
