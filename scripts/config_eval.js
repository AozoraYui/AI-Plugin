import assert from 'node:assert/strict'

globalThis.logger = globalThis.logger || { info() {}, warn() {}, error() {}, debug() {} }
const { Config } = await import('../utils/config.js')

const originalValue = Config.GROUP_DIGEST_MAX_LOGS

try {
    Config.GROUP_DIGEST_MAX_LOGS = undefined
    assert.equal(Config.GROUP_DIGEST_MAX_LOGS, 2000)

    Config.GROUP_DIGEST_MAX_LOGS = 5000
    assert.equal(Config.GROUP_DIGEST_MAX_LOGS, 5000)

    Config.GROUP_DIGEST_MAX_LOGS = 99
    assert.equal(Config.GROUP_DIGEST_MAX_LOGS, 100)

    Config.GROUP_DIGEST_MAX_LOGS = 10001
    assert.equal(Config.GROUP_DIGEST_MAX_LOGS, 10000)

    Config.GROUP_DIGEST_MAX_LOGS = 2500.9
    assert.equal(Config.GROUP_DIGEST_MAX_LOGS, 2500)

    Config.GROUP_DIGEST_MAX_LOGS = 'invalid'
    assert.equal(Config.GROUP_DIGEST_MAX_LOGS, 2000)

    console.log('配置评估通过：GROUP_DIGEST_MAX_LOGS 默认值、范围和非法输入处理正常。')
} finally {
    Config.GROUP_DIGEST_MAX_LOGS = originalValue
}
