#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const target = process.argv[2]
if (!target) { console.error('用法：node client-smoke.mjs <client.js>'); process.exit(1) }
let src
try { src = readFileSync(target, 'utf8') } catch { console.error(`✗ 读不到 ${target}`); process.exit(1) }
const cap = { id: null, factory: null, panels: [] }
const hooks = { useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useEffect() {}, useLayoutEffect() {}, useMemo: (f) => f(), useCallback: (f) => f, useRef: (v) => ({ current: v }), useContext: () => ({}), useReducer: (_r, v) => [v, () => {}], useId: () => 'smoke-id' }
const react = { createElement: (type, props, ...children) => ({ __vnode: true, type, props, children }), Fragment: 'Fragment', memo: (x) => x, forwardRef: (x) => x, ...hooks }
const doc = { head: {}, body: {}, documentElement: {}, createElement: () => ({ style: {}, remove() {}, appendChild() {}, setAttribute() {} }), getElementById: () => null }
const win = { __ModuleLoader__: { load({ id, factory }) { cap.id = id; cap.factory = factory } }, document: doc, localStorage: { getItem: () => null, setItem() {} }, fetch: () => Promise.resolve({ ok: true, json: async () => ({}) }), addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) }
const sandbox = { window: win, document: doc, localStorage: win.localStorage, fetch: win.fetch, console, setTimeout, clearTimeout, requestAnimationFrame: () => 0 }
sandbox.globalThis = sandbox
try { vm.createContext(sandbox); vm.runInContext(src, sandbox, { filename: target, timeout: 20000 }) } catch (e) { console.error(`✗ 模块加载失败：${e.message}`); process.exit(1) }
if (!cap.factory) { console.error('✗ 未调用 __ModuleLoader__.load'); process.exit(1) }
let exp
try { exp = cap.factory((name) => { if (name === 'react') return react; throw new Error(`未 mock 的 require: ${name}`) }) } catch (e) { console.error(`✗ factory 失败：${e.message}`); process.exit(1) }
if (typeof exp.apply !== 'function' || !Array.isArray(exp.inject)) { console.error('✗ client exports 不完整'); process.exit(1) }
const ctx = { slots: { inject(_slot, cb) { cb?.() }, register(spec, Comp) { cap.panels.push({ spec, Comp }) } }, on() {}, off() {}, emit() {}, get() {}, set() {}, effect() {}, logger: console }
try { exp.apply(ctx) } catch (e) { console.error(`✗ apply 失败：${e.message}`); process.exit(1) }
if (!cap.panels.length) { console.error('✗ 未注册面板'); process.exit(1) }
const Comp = cap.panels[0].Comp
try { const vnode = typeof Comp === 'function' ? Comp({}) : Comp?.render?.({}); if (!vnode || !vnode.__vnode) throw new Error('入口未返回 React vnode') } catch (e) { console.error(`✗ 入口渲染失败：${e.message}`); process.exit(1) }
console.log(`✓ 通用冒烟通过 id=${cap.id} panels=${cap.panels.length}`)
