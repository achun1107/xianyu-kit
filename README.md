# xianyu-kit

**闲鱼自动化的底层库**：浏览器会话、请求闸门、队列、工作流引擎、重试退避、结构化日志。

从一个实际在跑的内部项目里抽出来的公共部分。业务逻辑（发布、出价、选品）没有带过来，
这里只有那批脚本反复需要、又反复写错的东西。

```
lib/
  pipeline.js      工作流引擎：阶段依赖、重试退避、断点续跑、耗时统计
  agent.js         浏览器会话与页面操作
  browser-lock.js  多进程抢同一个浏览器时的互斥锁
  req-gate.js      请求闸门：限流 + 退避 + 状态落盘
  queue.js         串行队列
  http.js          HTTP 封装（超时、重试）
  mtop.js          闲鱼 mtop 接口的签名与调用
  env.js           配置读取（凭证一律走这里，不内联）
  config.json      配置模板（凭证字段留空）
  log.js           日志
  out.js           结构化输出
  idle.js          空闲检测
  args.js          命令行参数
  store-profile.js 店铺档案
  title.js         标题生成
  assign-areas.js  地区分配
  area-blocklist.json / city-areas.json  地区数据
  poster-templates-approved.json         贴图模板

bin/
  xianyu.js        命令行入口，把阶段串成工作流
```

---

## 工作流

原来的做法是一个几百行的单文件脚本，从上写到下：执行顺序靠代码位置，
失败靠每段自己的 try/catch，中途断了只能从头再跑。想跳过某步、想单独重试某步、
想看哪一步最慢，都做不到。

`lib/pipeline.js` 把这件事拆开：

```js
const p = new Pipeline('xianyu');
p.stage('prepare', async ctx => { /* 读配置 */ });
p.stage('login',   async ctx => { /* 起浏览器 */ }, { after: ['prepare'], retries: 2 });
p.stage('draft',   async ctx => { /* 生成内容 */ }, { after: ['prepare'], retries: 1 });
p.stage('listing', async ctx => { /* 提交 */ },     { after: ['login', 'draft'], retries: 3, backoff: 5000 });
await p.run({ ctx: {} });
```

它负责：

- **依赖排序** — 声明 `after` 即可，自动拓扑排序，成环会报错
- **重试退避** — `retries: 3, backoff: 5000` → 5s、10s、20s
- **可选阶段** — `optional: true` 失败不中止
- **断点续跑** — `--only login` / `--from draft` / `--until listing`
- **耗时统计** — 每步毫秒数 + 占比，找瓶颈

```bash
node bin/xianyu.js --dry              # 只看计划，不执行
node bin/xianyu.js                    # 全跑
node bin/xianyu.js --only draft       # 只跑一步
node bin/xianyu.js --from login       # 从某步开始
node bin/xianyu.js --until listing    # 跑到某步停
```

`bin/xianyu.js` 里那五个阶段是**空壳**（`prepare` / `login` / `draft` / `listing` / `verify`），
带注释说明每步该做什么。真实的业务实现要自己填 —— 这部分没有从内部项目带过来。

---

## 为什么抽出这些

内部脚本踩过的坑，几乎都在这几个模块里：

**1. 请求太密被封** — `req-gate.js`
按 10 分钟 / 1 小时双窗口限流，加最小间隔和最大等待，
状态落在 `<state>.lock` 里做跨进程互斥。崩了会留下锁文件，`*.json.lock` 已进 `.gitignore`。

**2. 多个进程抢一个浏览器** — `browser-lock.js`
同时在跑发布和调价时，两个进程会抢同一个 Chrome 实例，
表现为随机 `Target closed`。锁文件解决。

**3. 凭证内联在几十个文件里** — `env.js`
最初的写法是每个脚本自己写 `const KEY = 'xy_...'`，结果一处轮换要改 44 个文件。
现在统一走 `env.js`：读 `config.local.json`（不进库），或环境变量。

**4. 重试没有退避，把上游打挂** — `req-gate.js` 的 `backoffMinutes`
指数退避，且退避状态持久化，重启后不会立刻重打。

---

## 用法

```bash
npm install

# 复制配置模板，填自己的值（这个文件不进版本库）
cp lib/config.json lib/config.local.json

# 看工作流计划
node bin/xianyu.js --dry

# 读配置
node -e "const env = require('./lib/env'); console.log(env.service.host)"
```

`config.local.json` 的字段：

```json
{
  "service": { "host": "127.0.0.1", "port": 8093, "apiKey": "" },
  "reqGate": { "per10Min": 20, "perHour": 120, "minGapMs": 3000 }
}
```

`apiKey` 留空即可，`env.js` 会先读环境变量 `XIANYU_API_KEY`。

---

## 脱敏说明

这个仓库是从内部项目里**抽出来的**，不是整个导出的。抽取时做了：

- 只带 `lib/` 的通用模块和 `bin/` 的入口，不带业务脚本
- 不带任何运行数据（`ad-*.json`、`all-items.json` 这类含真实手机号/商品 ID 的文件）
- 不带账号文档（内部有「中台账号与 Key 对照」这类文件，不进这里）
- `config.json` 里的 `apiKey` 字段为空字符串
- 扫过一遍：硬编码密钥 / 邮箱 / 手机号，`lib/` 下无命中

---

## 已知限制

1. **只抽了库和骨架，没抽业务实现** — `bin/xianyu.js` 的五个阶段是空壳，
   想直接发布/调价，得自己往里填
2. **接口会变** — `mtop.js` 的签名算法跟着闲鱼前端走，过一阵子要重新对
3. **地区数据是特定城市的** — `city-areas.json` 里只有部分城市，需要自己补
4. **没有测试** — 原项目也没有，这是事实

## License

MIT

