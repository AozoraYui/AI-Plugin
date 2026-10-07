import assert from 'node:assert/strict'

const { createAgentBudget, createAgentTelemetry } = await import('../utils/agent_runtime.js')
const { executeAgentRound, planAgentContinuation, prepareAgentRound } = await import('../utils/agent_orchestrator.js')

function testPrepareAgentRound() {
    const prepared = prepareAgentRound([
        { name: 'read', args: {} },
        { name: 'read', args: {} },
        { name: 'write', args: { value: 1 } }
    ], {
        seenToolCalls: new Set(['read:{}']),
        sideEffectTools: ['write']
    })
    assert.deepEqual(prepared.tools.map(call => call.name), ['write'])
    assert.deepEqual(prepared.deferred, [])
    assert.equal(prepared.skipped.length, 2)

    const fresh = prepareAgentRound([
        { name: 'read', args: {} },
        { name: 'write', args: { value: 1 } }
    ], { sideEffectTools: ['write'] })
    assert.deepEqual(fresh.tools.map(call => call.name), ['read'])
    assert.deepEqual(fresh.deferred.map(call => call.name), ['write'])
}

async function testExecuteAgentRoundCollectsAndStops() {
    const budget = createAgentBudget({ maxToolCalls: 4 })
    const telemetry = createAgentTelemetry()
    const executed = []
    const callbacks = []
    const result = await executeAgentRound({
        registry: {
            async execute(name) {
                executed.push(name)
                return { success: true, data: { ok: true, verified: true, summary: `${name}完成` } }
            },
            formatToolResult(name, data) { return `${name}:${data.summary}` }
        },
        budget,
        telemetry,
        toolCalls: [
            { name: 'first', args: {} },
            { name: 'second', args: {} }
        ],
        onExecution(execution, executions) {
            callbacks.push({ name: execution.call.name, count: executions.length })
            return { stop: true }
        }
    })
    assert.deepEqual(executed, ['first'])
    assert.deepEqual(callbacks, [{ name: 'first', count: 1 }])
    assert.equal(result.executions.length, 1)
    assert.equal(result.summary.calls, 1)
    assert.equal(result.summary.successes, 1)
    assert.equal(result.summary.verified, 1)
    assert.equal(result.summary.budgetExhausted, false)
}

async function testContinuationPermissionBoundary() {
    const calls = [
        { name: 'web_search', args: { query: '信息' } },
        { name: 'shell_exec', args: { command: 'whoami' } },
        { name: 'web_search', args: { query: '信息' } }
    ]
    const result = await planAgentContinuation({
        analyze: async () => ({ tools: calls, intent: '检索信息' }),
        filterTools: tools => ({ tools, blocked: [] }),
        enabledTools: ['web_search'],
        allowedTools: ['web_search', 'shell_exec'],
        maxTools: 2
    })
    assert.deepEqual(result.tools.map(call => call.name), ['web_search'])
    assert.equal(result.skipped.length, 1)
    assert.equal(result.intent, '检索信息')

    let analyzerCalled = false
    const noPermissions = await planAgentContinuation({
        analyze: () => { analyzerCalled = true; return { tools: calls } },
        filterTools: tools => tools,
        enabledTools: [],
        allowedTools: ['shell_exec']
    })
    assert.equal(analyzerCalled, false)
    assert.deepEqual(noPermissions.tools, [])
    await assert.rejects(() => planAgentContinuation({
        analyze: async () => ({ tools: calls }),
        enabledTools: ['web_search'],
        allowedTools: ['web_search']
    }), /safety filter/)
}

async function testContinuationCannotExpandApprovedCalls() {
    const result = await planAgentContinuation({
        analyze: async () => ({ tools: [{ name: 'web_search', args: { query: 'allowed' } }] }),
        filterTools: tools => tools,
        normalizeTools: tools => [
            ...tools,
            { name: 'web_search', args: { query: 'unapproved' } },
            { name: 'shell_exec', args: { command: 'whoami' } }
        ],
        enabledTools: ['web_search', 'shell_exec'],
        allowedTools: ['web_search', 'shell_exec']
    })
    assert.deepEqual(result.tools, [{ name: 'web_search', args: { query: 'allowed' } }])
}

testPrepareAgentRound()
await testExecuteAgentRoundCollectsAndStops()
await testContinuationPermissionBoundary()
await testContinuationCannotExpandApprovedCalls()
console.log('Agent orchestrator eval: 4 passed, 0 failed')
