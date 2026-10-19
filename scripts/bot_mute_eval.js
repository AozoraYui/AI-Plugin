import assert from 'node:assert/strict'

global.logger = { debug() {}, info() {}, warn() {}, error() {} }

const {
    clearBotMuteCache,
    getBotMuteCacheSize,
    getBotMuteState,
    isBotMuted
} = await import('../utils/bot_mute.js')

function eventWithInfo(info) {
    let calls = 0
    return {
        event: {
            group_id: 100,
            self_id: 999,
            bot: {
                uin: 999,
                async sendApi(action) {
                    calls++
                    assert.equal(action, 'get_group_member_info')
                    return { data: info }
                }
            }
        },
        get calls() { return calls }
    }
}

const now = Date.now()
assert.equal(getBotMuteState({ mute_left: 30 }, now).muted, true)
assert.equal(getBotMuteState({ mute_left: 0 }, now).muted, false)
assert.equal(getBotMuteState({ shut_up_timestamp: Math.floor(now / 1000) + 30 }, now).muted, true)
assert.equal(getBotMuteState({ shut_up_timestamp: Math.floor(now / 1000) - 30 }, now).muted, false)
assert.equal(getBotMuteState({ shut_up_timestamp: now + 30000 }, now).muted, true)

clearBotMuteCache()
const muted = eventWithInfo({ mute_left: 60 })
assert.equal(await isBotMuted(muted.event), true)
assert.equal(muted.calls, 1)
assert.equal(await isBotMuted(muted.event), true)
assert.equal(muted.calls, 1)
assert.equal(getBotMuteCacheSize(), 1)

clearBotMuteCache()
const unmuted = eventWithInfo({ mute_left: 0, shut_up_timestamp: 0 })
assert.equal(await isBotMuted(unmuted.event), false)
assert.equal(unmuted.calls, 1)

clearBotMuteCache()
const memberInfoEvent = {
    group_id: 200,
    self_id: 888,
    group: {
        pickMember() {
            return { info: { mute_left: 10 } }
        }
    },
    bot: { uin: 888 }
}
assert.equal(await isBotMuted(memberInfoEvent), true)

clearBotMuteCache()
const failed = {
    group_id: 300,
    self_id: 777,
    bot: {
        uin: 777,
        async sendApi() { throw new Error('offline') }
    }
}
assert.equal(await isBotMuted(failed), false)

assert.equal(await isBotMuted({ group_id: 1, self_id: 2 }), false)
assert.equal(await isBotMuted({ user_id: 1 }), false)

console.log('Bot mute eval: 10 passed, 0 failed')
