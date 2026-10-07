import assert from 'node:assert/strict'

const {
    deterministicToolDecision,
    formatToolProtocol,
    normalizeToolResult
} = await import('../utils/tool_result.js')
const {
    createAgentBudget,
    createAgentTelemetry,
    executeAgentToolCalls,
    getAgentBudgetSnapshot,
    getAgentTelemetrySnapshot,
    resolveAgentRoundCompletion,
    summarizeAgentExecutions
} = await import('../utils/agent_runtime.js')

function testUnifiedProtocol() {
    const unverified = normalizeToolResult('demo', { ok: true, summary: '已读取' })
    assert.equal(unverified.status, 'success_unverified')
    assert.equal(unverified.retryable, false)
    assert.match(formatToolProtocol(unverified), /status=success_unverified/)
    assert.match(formatToolProtocol(unverified), /verified=false/)

    const verified = normalizeToolResult('demo', {
        ok: true,
        verified: true,
        rollback_info: { action: 'restore' }
    })
    assert.equal(verified.status, 'success_verified')
    assert.deepEqual(verified.rollbackInfo, { action: 'restore' })

    const statusOnlyFailure = normalizeToolResult('demo', { status: 'failed', error: '状态失败' })
    assert.equal(statusOnlyFailure.ok, false)
    assert.equal(statusOnlyFailure.status, 'failed')

    const statusOnlyWaiting = normalizeToolResult('demo', { status: 'waiting', summary: '等待确认' })
    assert.equal(statusOnlyWaiting.ok, true)
    assert.equal(statusOnlyWaiting.pending, true)
    assert.equal(deterministicToolDecision([statusOnlyWaiting]).completionStatus, 'waiting')

    const retryable = normalizeToolResult('demo', { ok: false, recoverable: true, error: '暂时失败' })
    assert.equal(retryable.status, 'failed_retryable')
    assert.equal(retryable.retryable, true)
    assert.equal(deterministicToolDecision([retryable]).completionStatus, 'continue')

    const partial = normalizeToolResult('demo', { ok: true, partial: true, next_hints: ['继续读取'] })
    assert.equal(partial.status, 'partial')
    assert.equal(deterministicToolDecision([partial]).completionStatus, 'continue')
}

async function testBudgetAndMetrics() {
    const budget = createAgentBudget({ maxToolCalls: 2 })
    const telemetry = createAgentTelemetry()
    const calls = []
    const executions = []
    const registry = {
        async execute(name, args) {
            calls.push({ name, args })
            return { success: true, data: { ok: true, verified: true, summary: `${name}完成` } }
        },
        formatToolResult(name, data) {
            return `${name}:${data.summary}`
        }
    }
    for await (const execution of executeAgentToolCalls({
        registry,
        budget,
        telemetry,
        toolCalls: [
            { name: 'first', args: {} },
            { name: 'second', args: {} },
            { name: 'third', args: {} }
        ]
    })) executions.push(execution)

    assert.equal(calls.length, 2)
    assert.equal(executions.length, 3)
    assert.equal(executions[0].status, 'ok')
    assert.equal(executions[0].protocolStatus, 'success_verified')
    assert.equal(executions[0].metrics.budgetUsed, 1)
    assert.equal(executions[0].protocol.metrics.attempt, 1)
    assert.ok(executions[0].protocol.metrics.elapsedMs >= 0)
    assert.equal(executions[2].status, 'failed')
    assert.equal(executions[2].budgetExhausted, true)
    assert.match(executions[2].result.error, /预算已用尽/)
    const snapshot = getAgentBudgetSnapshot(budget)
    assert.equal(snapshot.toolCalls, 2)
    assert.equal(snapshot.maxToolCalls, 2)
    assert.equal(snapshot.exhausted, true)
    assert.deepEqual(snapshot.byTool, { first: 1, second: 1 })
    const telemetrySnapshot = getAgentTelemetrySnapshot(telemetry)
    assert.equal(telemetrySnapshot.calls, 3)
    assert.equal(telemetrySnapshot.successes, 2)
    assert.equal(telemetrySnapshot.failures, 1)
    assert.equal(telemetrySnapshot.verified, 2)
    assert.equal(telemetrySnapshot.byTool.third.failures, 1)
}

async function testExecutionErrorsBecomeStructuredFailures() {
    const registry = {
        async execute() {
            throw new Error('模拟工具异常')
        },
        formatToolResult() { return '' }
    }
    const executions = []
    for await (const execution of executeAgentToolCalls({
        registry,
        toolCalls: [{ name: 'broken', args: {} }]
    })) executions.push(execution)
    assert.equal(executions[0].status, 'failed')
    assert.match(executions[0].protocol.error, /模拟工具异常/)
}

async function testMalformedToolResultsBecomeStructuredFailures() {
    const malformedExecutions = []
    for await (const execution of executeAgentToolCalls({
        registry: {
            async execute() { return null },
        },
        toolCalls: [{ name: 'malformed', args: {} }]
    })) malformedExecutions.push(execution)
    assert.equal(malformedExecutions.length, 1)
    assert.equal(malformedExecutions[0].status, 'failed')
    assert.match(malformedExecutions[0].protocol.error, /无效结果/)

    const contextExecutions = []
    for await (const execution of executeAgentToolCalls({
        registry: { async execute() { return { success: true, data: {} } } },
        contextFactory() { throw new Error('模拟上下文异常') },
        toolCalls: [{ name: 'context-failure', args: {} }]
    })) contextExecutions.push(execution)
    assert.equal(contextExecutions[0].status, 'failed')
    assert.match(contextExecutions[0].protocol.error, /模拟上下文异常/)

    const formatExecutions = []
    for await (const execution of executeAgentToolCalls({
        registry: {
            async execute() { return { success: true, data: { ok: true } } },
            formatToolResult() { throw new Error('模拟格式化异常') }
        },
        toolCalls: [{ name: 'format-failure', args: {} }]
    })) formatExecutions.push(execution)
    assert.equal(formatExecutions[0].status, 'ok')
    assert.match(formatExecutions[0].formattedResult, /模拟格式化异常/)
}

function testCrossModeExecutionSummary() {
    const executions = [
        {
            result: { success: true },
            protocol: { ok: true, verified: true, metrics: { elapsedMs: 12 } },
            pending: false,
            metrics: { elapsedMs: 12 }
        },
        {
            result: { success: true },
            protocol: { ok: false, retryable: true, status: 'failed_retryable', metrics: { elapsedMs: 8 } },
            pending: false,
            metrics: { elapsedMs: 8 }
        },
        {
            result: { success: false },
            protocol: { ok: false, retryable: false, status: 'failed', metrics: { elapsedMs: 4 } },
            pending: false,
            metrics: { elapsedMs: 4 }
        },
        {
            result: { success: true },
            protocol: { ok: true, partial: true, status: 'partial', metrics: { elapsedMs: 6 } },
            pending: false,
            metrics: { elapsedMs: 6 }
        },
        {
            result: { success: true },
            protocol: { ok: true, status: 'waiting', pending: true },
            pending: true
        }
    ]
    const summary = summarizeAgentExecutions(executions)
    assert.deepEqual({
        calls: summary.calls,
        successes: summary.successes,
        failures: summary.failures,
        verified: summary.verified,
        pending: summary.pending,
        partial: summary.partial,
        retryableFailures: summary.retryableFailures,
        terminalFailures: summary.terminalFailures,
        elapsedMs: summary.elapsedMs,
        allFailed: summary.allFailed,
        hasSuccessfulResult: summary.hasSuccessfulResult
    }, {
        calls: 5,
        successes: 2,
        failures: 2,
        verified: 1,
        pending: 1,
        partial: 1,
        retryableFailures: 1,
        terminalFailures: 1,
        elapsedMs: 30,
        allFailed: false,
        hasSuccessfulResult: true
    })
    assert.equal(summarizeAgentExecutions([{
        result: { success: false },
        protocol: { ok: false, status: 'blocked' },
        budgetExhausted: true
    }], { budget: { exhausted: true } }).budgetExhausted, true)
}

function testSharedRoundCompletionStateMachine() {
    const successfulSummary = {
        hasSuccessfulResult: true,
        allFailed: false,
        retryableFailures: 0,
        partial: 0,
        pending: 0
    }
    assert.equal(resolveAgentRoundCompletion({ summary: successfulSummary, verification: { completionStatus: 'ready' } }), 'ready')
    assert.equal(resolveAgentRoundCompletion({ summary: successfulSummary, pending: true, verification: { completionStatus: 'ready' } }), 'waiting')
    assert.equal(resolveAgentRoundCompletion({ summary: successfulSummary, researchEvidenceIncomplete: true, verification: { completionStatus: 'ready' } }), 'continue')
    assert.equal(resolveAgentRoundCompletion({ summary: successfulSummary, verification: { completionStatus: 'invalid' } }), 'continue')
    assert.equal(resolveAgentRoundCompletion({
        summary: { allFailed: true, retryableFailures: 0, hasSuccessfulResult: false, partial: 0, pending: 0 }
    }), 'blocked')
    assert.equal(resolveAgentRoundCompletion({
        summary: { allFailed: true, retryableFailures: 1, hasSuccessfulResult: false, partial: 0, pending: 0 }
    }), 'continue')
}

testUnifiedProtocol()
await testBudgetAndMetrics()
await testExecutionErrorsBecomeStructuredFailures()
await testMalformedToolResultsBecomeStructuredFailures()
testCrossModeExecutionSummary()
testSharedRoundCompletionStateMachine()
console.log('Agent runtime eval: 6 passed, 0 failed')
