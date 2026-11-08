#!/usr/bin/env node
/**
 * bin/xianyu.js —— 命令行入口
 *
 * 把 lib/pipeline 串成一条可断点续跑的工作流。
 * 这里只定义骨架，具体每一步做什么要按自己的业务填。
 *
 *   node bin/xianyu.js --dry                     # 看计划
 *   node bin/xianyu.js                           # 全跑
 *   node bin/xianyu.js --only prepare            # 只跑一步
 *   node bin/xianyu.js --from login              # 从某步开始
 *   node bin/xianyu.js --until listing           # 跑到某步
 */
'use strict';

const { Pipeline } = require('../lib/pipeline');
const { log } = require('../lib/log');

// ── 参数 ──
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const has = n => process.argv.includes('--' + n);

const CTX = {
  task: arg('task', 'default'),
  store: arg('store', ''),
  dry: has('dry'),
};

const p = new Pipeline('xianyu');

// ── 阶段定义 ──
// 每一步都独立可跑，靠 ctx 传递中间结果。
// 真实的业务实现填在 run() 里，这里留空壳并标注该做什么。

p.stage('prepare', async (ctx) => {
  // 读配置、校验必需字段、检查浏览器可执行路径
  const env = require('../lib/env');
  if (!env.service || !env.service.host) {
    throw new Error('config.local.json 缺 service.host');
  }
  log.info(`目标服务 ${env.service.host}:${env.service.port || '-'}`);
  return { env };
}, { retries: 0 });

p.stage('login', async (ctx) => {
  // 确保浏览器会话可用（复用已登录的 profile，不重复扫码）
  const lock = require('../lib/browser-lock');
  if (!lock.tryAcquire()) {
    throw new Error('另一个进程正在用浏览器（browser-lock）');
  }
  try {
    // ... 打开页面、检查登录态
    log.info('浏览器会话就绪');
  } finally {
    lock.release();
  }
}, { after: ['prepare'], retries: 2, backoff: 3000 });

p.stage('draft', async (ctx) => {
  // 生成文案 / 标题 / 图片
  const title = require('../lib/title');
  log.info('草稿已生成（示例阶段，按需实现）');
  return { draft: {} };
}, { after: ['prepare'], retries: 1 });

p.stage('listing', async (ctx) => {
  // 提交上架 —— 走请求闸门，别把上游打挂
  const gate = require('../lib/req-gate');
  await gate.acquire();
  try {
    log.info('已提交（示例阶段，按需实现）');
  } finally {
    await gate.release();
  }
}, { after: ['login', 'draft'], retries: 3, backoff: 5000 });

p.stage('verify', async (ctx) => {
  // 回查结果，落到 out/
  log.info('回查完成（示例阶段，按需实现）');
}, { after: ['listing'], retries: 1, optional: true });

// ── 跑 ──
(async () => {
  try {
    const { timeline } = await p.run({
      ctx: CTX,
      dry: has('dry'),
      only: arg('only'),
      from: arg('from'),
      until: arg('until'),
    });
    if (timeline.length) Pipeline.report(timeline);
  } catch (e) {
    log.error(e.message);
    if (e.timeline) Pipeline.report(e.timeline);
    process.exit(1);
  }
})();
