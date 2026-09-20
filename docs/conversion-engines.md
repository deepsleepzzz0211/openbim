# 转换引擎与路由（工单 09）

平台有两个三角化引擎，产物契约完全一致（meta.json + 单文件/分块 GLB，见工单 05），
Web 端无需感知差异。

| 引擎 | 实现 | 进程边界 | 适用 |
| --- | --- | --- | --- |
| `wasm` | web-ifc（`packages/ifc`） | API 的 worker 线程池（`CONVERSION_MODE=worker`） | 默认；≤ 安全阈值的模型 |
| `native` | IfcOpenShell（`docker/ifcopenshell-worker/`） | 独立容器 + 每文件一个子进程 | 超过 wasm 安全阈值的大模型 |

## 为什么 native 必须是独立容器

IfcOpenShell 是 LGPL 许可。通过"独立进程 + HTTP 作业协议 + 只交换文件路径"的
方式调用，主平台代码与 LGPL 代码之间没有链接期耦合，满足 LGPL 的进程隔离边界。
容器镜像同时提供资源上限（见下文），单个超大模型不会拖垮 API。

## 路由规则（`apps/api/src/conversion/engineRouting.ts`）

1. **按大小**：源文件 ≥ `NATIVE_THRESHOLD_BYTES`（默认 256 MiB，即 web-ifc 的
   实用安全上限）→ `native`；否则 `wasm`。
2. **同模型禁止混用**：一个模型（model）的所有版本必须使用同一引擎——两种引擎
   的曲面离散化不同，混用会让版本对比（diff / clash）比较的是"不同三角化"而不
   是"不同设计"。新版本的引擎继承该模型最近一个已转换版本的引擎；工单 09 之前的
   历史版本（engine 为 NULL）一律视为 `wasm`。引擎在 `Version.engine` 落库，
   转换失败也记录（重试保持同一引擎）。
3. **未配置 worker 时降级**：若 `NATIVE_WORKER_URL` 为空，超限任务仍走 `wasm`
   并打 warn 日志（保证小规模自托管可用）；已配置 worker 但作业失败时**不会**
   静默切回 wasm，而是 `FAILED` + 明确 errorCode（规则 2）。

## 环境变量（API）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NATIVE_WORKER_URL` | 空（native 不可用） | 转换容器地址，如 `http://ifc-worker:8090` |
| `NATIVE_WORKER_TOKEN` | 空 | 与容器 `WORKER_TOKEN` 配对的 Bearer 密钥 |
| `NATIVE_THRESHOLD_BYTES` | `268435456` | 路由到 native 的源文件大小阈值 |
| `NATIVE_WORKER_TIMEOUT_MS` | 4 小时 | 单个 native 作业的墙钟预算 |

## 作业协议（容器侧，`docker/ifcopenshell-worker/worker.py`）

```
POST /convert  {job_id, input_path, glb_path, meta_path, chunking?}  -> 202 {job_id}
GET  /jobs/{id}  -> {status:"running", percent} | {status:"done", stats, schema}
                 | {status:"failed", code, message}      未知 id -> 404
GET  /health     -> {ok:true, engine:"ifcopenshell"}
```

- 路径都是**共享卷上的绝对路径**（compose 中两侧同挂 `hubdata:/data`），请求体
  不携带任何几何数据。
- 每个作业由容器启动一个 `python -m ifw.run_job` 子进程（每文件一进程：崩溃
  隔离、内存彻底归还）；进度经 stdout 协议回传。
- `IFC_WORKER_THREADS`（默认 4）传给 IfcOpenShell 的多线程三角化；
  `MAX_CONCURRENT_JOBS`（默认 1）限制同容器并发子进程数。

### 资源限额（docker-compose 默认值，按需上调）

`ifc-worker`：`mem_limit: 6g`、`cpus: 4`。500 MB 级源文件在 4 线程下约需
4–6 GB 峰值内存（OCC 内核 + Python 侧展开）；更大模型请同时提高
`MAX_CONCURRENT_JOBS=1`（保持串行）与 `mem_limit`。

## 失败码

| code | 含义 | 处置 |
| --- | --- | --- |
| `NATIVE_UNAVAILABLE` | 容器不可达 / 拒绝提交 / 连续 3 次轮询失败 | 检查 ifc-worker 容器；重试转换即可 |
| `NATIVE_JOB_LOST` | 容器中途重启，作业丢失 | 自动安全：重触发 reconvert |
| `NATIVE_TIMEOUT` | 超过 `NATIVE_WORKER_TIMEOUT_MS` | 提高超时或降低模型规模 |
| `NATIVE_CRASH` | 转换子进程异常退出 | 看容器日志中该 job 的 stderr |
| `PARSE_FAILED` / `EMPTY_MODEL` | 源文件问题 | 与 wasm 引擎同义 |

## 双引擎一致性回归

`.github/workflows/engine-parity.yml`（手动触发档起步，稳定后可升级为
schedule）：对 `samples/complex` 全量模型逐一对拉

- 三角数（相对偏差 `PARITY_TRI_TOL`，默认 0.15——两引擎曲面细分策略不同，
  绝对一致不现实，回归的是"不跑偏"）
- 包围盒三轴尺寸（`PARITY_DIM_TOL` 0.02 + 5 cm 地板）
- 表面积（`PARITY_AREA_TOL` 0.10）
- 产物格式（single/chunked）与各桶 ranges 合法性

本地运行（需 Python 环境装好 ifcopenshell）：

```bash
pip install "ifcopenshell>=0.7,<0.9"
cd docker/ifcopenshell-worker && python worker.py &
node scripts/engine-parity.mjs --native http://127.0.0.1:8090
```

容器包的纯 Python 部分（分块路由 / GLB 写出 / 产物契约）由 stdlib unittest
覆盖（`python3 -m unittest discover -s tests -t .`），已进入 CI。
