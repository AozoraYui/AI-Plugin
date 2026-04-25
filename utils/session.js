import { Config } from './config.js'

export const sessionManager = {
    sessions: new Map(),
    set(userId, sessionData, timeoutCallback) {
        if (this.sessions.has(userId)) {
            clearTimeout(this.sessions.get(userId).timer)
        }
        const timer = setTimeout(() => {
            if (this.sessions.has(userId)) {
                this.sessions.delete(userId)
                if (timeoutCallback) timeoutCallback()
            }
        }, Config.SESSION_TIMEOUT_MS)
        this.sessions.set(userId, { ...sessionData, timer })
    },
    get(userId) { return this.sessions.get(userId) },
    has(userId) { return this.sessions.has(userId) },
    delete(userId) {
        if (this.sessions.has(userId)) {
            clearTimeout(this.sessions.get(userId).timer)
            return this.sessions.delete(userId)
        }
        return false
    }
}
