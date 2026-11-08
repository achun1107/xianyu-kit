# xianyu-kit

**闲鱼自动化的底层库**：浏览器会话、请求闸门、队列、重试退避、结构化日志。

从一个实际在跑的内部项目里抽出来的公共部分。业务逻辑（发布、出价、选品）没有带过来，
这里只有那批脚本反复需要、又反复写错的东西。

```
lib/
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
```

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

# 读配置
node -e "const env = require('./lib/env'); console.log(env.service.host)"

# 限流器
node -e "
const gate = require('./lib/req-gate');
await gate.acquire();
// ... 发请求
await gate.release();
"
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

- 只带 `lib/` 的通用模块，不带业务脚本
- 不带任何运行数据（`ad-*.json`、`all-items.json` 这类含真实手机号/商品 ID 的文件）
- 不带账号文档（内部有「中台账号与 Key 对照」这类文件，不进这里）
- `config.json` 里的 `apiKey` 字段为空字符串
- 扫过一遍：硬编码密钥 / 邮箱 / 手机号，`lib/` 下无命中

---

## 已知限制

1. **只抽了库，没抽流程** — 想直接跑发布/调价，还需要自己写上层脚本
2. **接口会变** — `mtop.js` 的签名算法跟着闲鱼前端走，过一阵子要重新对
3. **地区数据是特定城市的** — `city-areas.json` 里只有部分城市，需要自己补
4. **没有测试** — 原项目也没有，这是事实

## License

MIT
