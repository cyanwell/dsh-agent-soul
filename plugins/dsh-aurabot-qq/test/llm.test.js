// 思考强度：不支持的模型不能传 reasoningEffort（否则 DSH 整轮报错），支持的要按能力收敛。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { askModel, modelReasoning, pickReasoningEffort, clearReasoningCache } = await import('../src/core/llm.js')

const CFG = { model: { provider: 'p', model: 'm' } }

/**
 * reasoning: undefined = 适配器报错（查不到）；null = 没有推理元数据；{efforts, default} = 支持
 */
function fakeDsh ({ reasoning, stream }) {
  const calls = []
  let lookups = 0
  const dsh = {
    get: (n) => (n === 'llm' ? dsh.llm : undefined),
    llm: {
      async resolveModelInfo (provider, model) {
        lookups++
        if (reasoning === undefined) throw new Error('adapter 不支持查询')
        return { provider, id: model, name: model, ...(reasoning === null ? {} : { reasoning }) }
      },
      async *stream (params) {
        calls.push(params)
        if (stream) return yield * stream(params, calls)
        yield { type: 'text-delta', text: 'ok' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  return { dsh, calls, lookups: () => lookups }
}

test('没有推理元数据的模型：不返回档位，也不传 reasoningEffort', async () => {
  clearReasoningCache()
  const { dsh, calls } = fakeDsh({ reasoning: null })
  assert.equal(await modelReasoning(dsh, 'p', 'm'), null)
  assert.equal(await pickReasoningEffort(dsh, 'p', 'm', 'low'), undefined)

  const text = await askModel(dsh, { cfg: CFG, text: '在吗' })
  assert.equal(text, 'ok')
  assert.equal('reasoningEffort' in calls[0], false, '非推理模型不能带 reasoningEffort')
})

test('查不到能力（适配器报错）也当作不支持', async () => {
  clearReasoningCache()
  const { dsh, calls } = fakeDsh({ reasoning: undefined })
  assert.equal(await modelReasoning(dsh, 'p', 'm'), null)
  await askModel(dsh, { cfg: CFG, text: '在吗' })
  assert.equal('reasoningEffort' in calls[0], false)
})

test('支持的模型：按能力取值，越界就退回模型默认', async () => {
  clearReasoningCache()
  const { dsh } = fakeDsh({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' } })
  assert.deepEqual(await modelReasoning(dsh, 'p', 'm'), { efforts: ['low', 'high'], default: 'high' })
  assert.equal(await pickReasoningEffort(dsh, 'p', 'm', 'low'), 'low', '想要的档位支持就用')
  assert.equal(await pickReasoningEffort(dsh, 'p', 'm', 'max'), 'high', '不支持的档位退回模型默认')
  assert.equal(await pickReasoningEffort(dsh, 'p', 'm', ''), 'high', '没指定就用模型默认')
})

test('支持的模型：askModel 会把档位传下去', async () => {
  clearReasoningCache()
  const { dsh, calls } = fakeDsh({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' } })
  await askModel(dsh, { cfg: CFG, text: '在吗', reasoningEffort: 'low' })
  assert.equal(calls[0].reasoningEffort, 'low')
})

test('万一还是被拒：去掉 reasoningEffort 自动重试一次', async () => {
  clearReasoningCache()
  let n = 0
  const { dsh, calls } = fakeDsh({
    reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' },
    stream: async function * (params) {
      if (params.reasoningEffort && n++ === 0) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'model does not support reasoning effort "high"' } } }
        return
      }
      yield { type: 'text-delta', text: '第二次好了' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const text = await askModel(dsh, { cfg: CFG, text: '在吗' })
  assert.equal(text, '第二次好了')
  assert.equal(calls.length, 2, '应该重试一次')
  assert.ok(calls[0].reasoningEffort, '第一次带了档位')
  assert.equal('reasoningEffort' in calls[1], false, '第二次不带档位')
  // 被拒过之后缓存记为不支持，下次直接不传
  assert.equal(await modelReasoning(dsh, 'p', 'm'), null)
})

test('能力结果有缓存，不会每次都去问适配器', async () => {
  clearReasoningCache()
  const { dsh, lookups } = fakeDsh({ reasoning: { efforts: [{ id: 'low' }] } })
  await modelReasoning(dsh, 'p', 'm')
  await modelReasoning(dsh, 'p', 'm')
  await pickReasoningEffort(dsh, 'p', 'm', 'low')
  assert.equal(lookups(), 1, '同一个模型只查一次')
})

test('宿主没有能力查询接口（老版本 DSH）：维持老行为，照传配置的档位', async () => {
  clearReasoningCache()
  const calls = []
  const dsh = {
    get: (n) => (n === 'llm' ? dsh.llm : undefined),
    llm: {
      // 故意不提供 resolveModelInfo
      async *stream (params) {
        calls.push(params)
        yield { type: 'text-delta', text: 'ok' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  assert.equal(await pickReasoningEffort(dsh, 'p', 'm', 'max'), 'max')
  await askModel(dsh, { cfg: CFG, text: '在吗', reasoningEffort: 'max' })
  assert.equal(calls[0].reasoningEffort, 'max', '查不了就别偷偷丢掉用户配置')
})
