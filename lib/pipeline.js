/**
 * lib/pipeline.js —— 把「一个几百行的脚本」拆成可组合的阶段
 *
 * 为什么需要：
 *   内部的主流程（publish-one.js 这类）是单文件从上写到下，
 *   执行顺序靠代码位置决定，失败靠 try/catch 各自处理，
 *   中途断了只能从头再跑。想跳过某步、想重试某步、想看每步耗时，都做不到。
 *
 * 这个模块只做三件事：
 *   1. 按名字定义阶段，阶段之间显式声明依赖
 *   2. 顺序执行，单阶段失败可重试，重试有退避
 *   3. 每步的耗时/结果写进 context，可断点续跑（--from / --only）
 *
 * 不涉及任何业务逻辑。
 */
'use strict';

const { log } = require('./log');

/**
 * @typedef {Object} Stage
 * @property {string} name       阶段名，唯一
 * @property {string[]} [after]  依赖的阶段名（必须已注册）
 * @property {Function} run      async (ctx) => Partial<ctx> | void
 * @property {number} [retries]  失败重试次数，默认 0
 * @property {number} [backoff]  首次退避毫秒，默认 2000（指数增长）
 * @property {boolean} [optional] 允许失败并继续
 */

class Pipeline {
  constructor(name) {
    this.name = name || 'pipeline';
    this.stages = new Map();
    this.order = [];
  }

  /**
   * 注册一个阶段。
   * @param {string} name
   * @param {Function} run
   * @param {{after?: string[], retries?: number, backoff?: number, optional?: boolean}} [opts]
   */
  stage(name, run, opts = {}) {
    if (this.stages.has(name)) {
      throw new Error(`stage 重名：${name}`);
    }
    this.stages.set(name, {
      name,
      run,
      after: opts.after || [],
      retries: opts.retries || 0,
      backoff: opts.backoff || 2000,
      optional: !!opts.optional,
    });
    this.order.push(name);
    return this;
  }

  /** 检查依赖是否都能满足（注册了就行，不要求顺序）。 */
  validate() {
    const names = new Set(this.stages.keys());
    for (const s of this.stages.values()) {
      for (const dep of s.after) {
        if (!names.has(dep)) {
          throw new Error(`stage ${s.name} 依赖的 ${dep} 不存在`);
        }
      }
    }
    // 拓扑排序，检查环
    const done = new Set();
    const visit = (n, stack) => {
      if (done.has(n)) return;
      if (stack.has(n)) {
        throw new Error(`依赖成环：${[...stack, n].join(' → ')}`);
      }
      stack.add(n);
      const s = this.stages.get(n);
      for (const d of s.after) visit(d, stack);
      stack.delete(n);
      done.add(n);
    };
    for (const n of this.order) visit(n, new Set());
    return this;
  }

  /**
   * 跑起来。
   * @param {Object} [opts]
   * @param {Object} [opts.ctx]    初始上下文
   * @param {string} [opts.only]   只跑这个阶段
   * @param {string} [opts.from]   从这个阶段开始（含）
   * @param {string} [opts.until]  跑到这个阶段（含）
   * @param {boolean} [opts.dry]   只打印计划不执行
   * @param {Function} [opts.onStage] 每个阶段结束后的回调 (stage, result, err)
   */
  async run(opts = {}) {
    this.validate();
    const ctx = opts.ctx || {};
    const timeline = [];
    const names = this.order;

    let start = 0;
    if (opts.only) {
      const i = names.indexOf(opts.only);
      if (i < 0) throw new Error(`没有 stage：${opts.only}`);
      start = i;
    } else if (opts.from) {
      const i = names.indexOf(opts.from);
      if (i < 0) throw new Error(`没有 stage：${opts.from}`);
      start = i;
    }
    const end = opts.until ? names.indexOf(opts.until) : names.length - 1;
    const plan = names.slice(start, end + 1);

    if (opts.dry) {
      console.log(`[${this.name}] 计划 ${plan.length} 步：`);
      plan.forEach((n, i) => {
        const s = this.stages.get(n);
        const dep = s.after.length ? `  after: ${s.after.join(',')}` : '';
        const retry = s.retries ? `  retries: ${s.retries}` : '';
        console.log(`  ${i + 1}. ${n}${dep}${retry}`);
      });
      return { ctx, timeline: [] };
    }

    for (const name of plan) {
      const s = this.stages.get(name);
      const t0 = Date.now();
      let attempt = 0;
      let lastErr = null;

      while (attempt <= s.retries) {
        try {
          log.info(`[${name}] 开始${attempt ? ` (第 ${attempt + 1} 次)` : ''}`);
          const ret = await s.run(ctx);
          if (ret && typeof ret === 'object') Object.assign(ctx, ret);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          attempt += 1;
          if (attempt > s.retries) break;
          const wait = s.backoff * Math.pow(2, attempt - 1);
          log.warn(`[${name}] 失败：${err.message}；${wait}ms 后重试`);
          await new Promise(r => setTimeout(r, wait));
        }
      }

      const ms = Date.now() - t0;
      if (lastErr) {
        timeline.push({ name, ok: false, ms, error: lastErr.message });
        if (s.optional) {
          log.warn(`[${name}] 可选阶段失败，继续`);
        } else {
          log.error(`[${name}] 失败，中止`);
          const e = new Error(`stage ${name} 失败：${lastErr.message}`);
          e.timeline = timeline;
          throw e;
        }
      } else {
        timeline.push({ name, ok: true, ms });
        log.info(`[${name}] 完成 ${ms}ms`);
      }
      if (opts.onStage) opts.onStage(name, timeline[timeline.length - 1], lastErr);
    }

    return { ctx, timeline };
  }

  /** 打印每步耗时，排查慢步骤用。 */
  static report(timeline) {
    const total = timeline.reduce((a, b) => a + b.ms, 0);
    console.log(`\n共 ${timeline.length} 步，${total}ms`);
    for (const t of timeline) {
      const mark = t.ok ? '✓' : '✗';
      const pct = total ? Math.round((t.ms / total) * 100) : 0;
      console.log(`  ${mark} ${t.name.padEnd(24)} ${String(t.ms).padStart(7)}ms  ${String(pct).padStart(3)}%`);
    }
  }
}

module.exports = { Pipeline };
