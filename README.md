# Cloudflare Worker DoH Proxy

高性能 DNS-over-HTTPS (DoH) 代理服务，部署在 Cloudflare Workers 上。

## 功能特性

✅ **RFC 8484 标准兼容** - 完全符合 DNS-over-HTTPS 协议标准
✅ **GET 和 POST 支持** - 支持两种 HTTP 方法进行 DoH 查询
✅ **响应竞赛算法** - 并发查询多个上游 DoH 服务器，使用最快响应
✅ **智能线路选择** - 基于性能历史智能选择最优上游服务器
✅ **地理位置路由** - 根据用户 IP 自动选择最近的 DNS 服务器
✅ **高性能缓存** - 自动缓存 DNS 响应，提升查询速度
✅ **浏览器友好** - 完整的 CORS 支持，可在所有主流浏览器中使用
✅ **无配置文件** - 不需要 wrangler.toml，使用环境变量配置
✅ **高可用性** - 自动故障转移和重试机制

## 快速开始

### 部署到 Cloudflare Workers

```bash
# 部署 Worker
npx wrangler deploy index.js

# 设置环境变量（可选）
npx wrangler secret put DOH_UPSTREAMS
# 输入值例如: https://cloudflare-dns.com/dns-query,https://dns.google/dns-query
```

### 设置自定义域名

1. 在 Cloudflare Dashboard 中进入 Workers & Pages
2. 选择你的 Worker
3. 点击 "Triggers" 标签
4. 添加自定义域名

### 环境变量配置

在 Cloudflare Workers 设置中配置以下环境变量：

- `DOH_UPSTREAMS`: 逗号分隔的上游 DoH 服务器列表

  示例：
  ```
  https://cloudflare-dns.com/dns-query,https://dns.google/dns-query,https://dns.quad9.net/dns-query
  ```

## 使用方法

### API 端点

**路径**: `/dns-query`

### GET 请求示例

```bash
# 查询 google.com 的 A 记录
curl -H "Accept: application/dns-message" \
  "https://your-domain.workers.dev/dns-query?dns=AAABAAABAAAAAAAAA3d3dwZnb29nbGUDY29tAAABAAE"
```

### POST 请求示例

```bash
# 使用 POST 方法查询
curl -X POST \
  -H "Content-Type: application/dns-message" \
  -H "Accept: application/dns-message" \
  --data-binary @dns-query.bin \
  "https://your-domain.workers.dev/dns-query"
```

### 浏览器配置

#### Chrome / Edge

1. 打开 `chrome://settings/security`
2. 找到 "使用安全 DNS"
3. 选择 "使用自定义"
4. 输入: `https://your-domain.workers.dev/dns-query`

#### Firefox

1. 打开 `about:preferences#general`
2. 滚动到 "网络设置"
3. 点击 "设置"
4. 启用 "DNS over HTTPS"
5. 选择 "自定义"
6. 输入: `https://your-domain.workers.dev/dns-query`

#### Safari (macOS)

1. 安装 DoH 配置文件或使用第三方工具

### JavaScript 客户端示例

```javascript
// GET 请求
async function dohQuery(domain) {
  const dnsQuery = buildDNSQuery(domain, 'A');
  const encodedQuery = base64urlEncode(dnsQuery);

  const response = await fetch(
    `https://your-domain.workers.dev/dns-query?dns=${encodedQuery}`,
    {
      headers: {
        'Accept': 'application/dns-message'
      }
    }
  );

  return await response.arrayBuffer();
}

// POST 请求
async function dohQueryPost(domain) {
  const dnsQuery = buildDNSQuery(domain, 'A');

  const response = await fetch(
    'https://your-domain.workers.dev/dns-query',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/dns-message',
        'Accept': 'application/dns-message'
      },
      body: dnsQuery
    }
  );

  return await response.arrayBuffer();
}
```

## 测试工具

打开 `test.html` 在浏览器中测试 DoH 代理功能：

1. 选择请求方法（GET 或 POST）
2. 输入要查询的域名
3. 选择记录类型（A, AAAA, CNAME 等）
4. 点击查询按钮

测试工具会显示：
- 请求方法
- 响应时间
- 上游服务器
- 缓存状态
- DNS 查询结果

## 工作原理

### 响应竞赛算法

Worker 同时向多个上游 DoH 服务器发送请求，使用最快返回的响应。这确保了：
- 最低延迟
- 高可用性
- 自动故障转移

### 智能路由

基于历史性能数据选择最优上游服务器：
- 跟踪每个上游的平均延迟
- 监控成功率
- 动态调整服务器优先级

### 地理位置路由

根据客户端 IP 地址自动选择最近的区域服务器：
- 北美 (NA)
- 欧洲 (EU)
- 亚洲 (AS)
- 大洋洲 (OC)
- 南美 (SA)
- 非洲 (AF)

### 缓存机制

- 使用 Cloudflare Cache API
- 默认缓存 5 分钟
- 显著提升重复查询性能
- 降低上游服务器负载

## 性能特性

- **并发查询**: 同时查询多个上游服务器
- **智能选择**: 基于性能历史选择最佳服务器
- **边缘缓存**: 利用 Cloudflare 全球网络缓存
- **超时保护**: 5 秒超时，自动重试
- **地理优化**: 自动选择最近的 DNS 服务器

## 安全性

- ✅ 仅支持 HTTPS 加密传输
- ✅ 符合 RFC 8484 标准
- ✅ 输入验证和大小限制
- ✅ 无日志记录
- ✅ CORS 保护

## 默认上游服务器

- Cloudflare DNS: `https://cloudflare-dns.com/dns-query`
- Google DNS: `https://dns.google/dns-query`
- Quad9 DNS: `https://dns.quad9.net/dns-query`
- OpenDNS: `https://doh.opendns.com/dns-query`

可通过 `DOH_UPSTREAMS` 环境变量自定义。

## 响应头

Worker 返回以下自定义响应头：

- `X-Cache`: HIT 或 MISS（缓存状态）
- `X-Upstream`: 实际响应的上游服务器
- `X-Latency`: 上游响应时间（毫秒）

## 故障排除

### 查询失败

- 检查域名格式是否正确
- 验证上游服务器是否可访问
- 查看浏览器控制台错误信息

### 浏览器不工作

- 确保使用 HTTPS（不是 HTTP）
- 检查 CORS 设置
- 尝试不同的浏览器

### 性能问题

- 检查上游服务器响应时间
- 验证缓存是否正常工作
- 考虑添加更多地理上接近的上游服务器

## 许可证

MIT License