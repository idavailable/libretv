import path from 'path';
import express from 'express';
import axios from 'axios';
import cors from 'cors';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = {
  port: process.env.PORT || 8080,
  password: process.env.PASSWORD || '',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  timeout: parseInt(process.env.REQUEST_TIMEOUT || '5000'),
  maxRetries: parseInt(process.env.MAX_RETRIES || '2'),
  cacheMaxAge: process.env.CACHE_MAX_AGE || '1d',
  userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  debug: process.env.DEBUG === 'true'
};

const log = (...args) => {
  if (config.debug) {
    console.log('[DEBUG]', ...args);
  }
};

const app = express();

app.use(cors({
  origin: config.corsOrigin,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

function sha256Hash(input) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    hash.update(input);
    resolve(hash.digest('hex'));
  });
}

async function renderPage(filePath, password) {
  let content = fs.readFileSync(filePath, 'utf8');
  if (password !== '') {
    const sha256 = await sha256Hash(password);
    content = content.replace('{{PASSWORD}}', sha256);
  } else {
    content = content.replace('{{PASSWORD}}', '');
  }
  return content;
}

app.get(['/', '/index.html', '/player.html'], async (req, res) => {
  try {
    let filePath;
    switch (req.path) {
      case '/player.html':
        filePath = path.join(__dirname, 'player.html');
        break;
      default: // '/' 和 '/index.html'
        filePath = path.join(__dirname, 'index.html');
        break;
    }
    
    const content = await renderPage(filePath, config.password);
    res.send(content);
  } catch (error) {
    console.error('页面渲染错误:', error);
    res.status(500).send('读取静态页面失败');
  }
});

app.get('/s=:keyword', async (req, res) => {
  try {
    const filePath = path.join(__dirname, 'index.html');
    const content = await renderPage(filePath, config.password);
    res.send(content);
  } catch (error) {
    console.error('搜索页面渲染错误:', error);
    res.status(500).send('读取静态页面失败');
  }
});

function isValidUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const allowedProtocols = ['http:', 'https:'];
    
    // 从环境变量获取阻止的主机名列表
    const blockedHostnames = (process.env.BLOCKED_HOSTS || 'localhost,127.0.0.1,0.0.0.0,::1').split(',');
    
    // 从环境变量获取阻止的 IP 前缀
    const blockedPrefixes = (process.env.BLOCKED_IP_PREFIXES || '192.168.,10.,172.').split(',');
    
    if (!allowedProtocols.includes(parsed.protocol)) return false;
    if (blockedHostnames.includes(parsed.hostname)) return false;
    
    for (const prefix of blockedPrefixes) {
      if (parsed.hostname.startsWith(prefix)) return false;
    }
    
    return true;
  } catch {
    return false;
  }
}

// 验证代理请求的鉴权
function validateProxyAuth(req) {
  const authHash = req.query.auth;
  const timestamp = req.query.t;
  
  // 获取服务器端密码哈希
  const serverPassword = config.password;
  if (!serverPassword) {
    console.error('服务器未设置 PASSWORD 环境变量，代理访问被拒绝');
    return false;
  }
  
  // 使用 crypto 模块计算 SHA-256 哈希
  const serverPasswordHash = crypto.createHash('sha256').update(serverPassword).digest('hex');
  
  if (!authHash || authHash !== serverPasswordHash) {
    console.warn('代理请求鉴权失败：密码哈希不匹配');
    console.warn(`期望: ${serverPasswordHash}, 收到: ${authHash}`);
    return false;
  }
  
  // 验证时间戳（10分钟有效期）
  if (timestamp) {
    const now = Date.now();
    const maxAge = 10 * 60 * 1000; // 10分钟
    if (now - parseInt(timestamp) > maxAge) {
      console.warn('代理请求鉴权失败：时间戳过期');
      return false;
    }
  }
  
  return true;
}

// 根据目标 URL 生成防盗链所需的 Referer
function buildReferer(targetUrl) {
  try {
    const { origin, hostname } = new URL(targetUrl);
    if (/(^|\.)doubanio\.com$|(^|\.)douban\.com$/.test(hostname)) {
      return 'https://movie.douban.com/';
    }
    return `${origin}/`;
  } catch {
    return undefined;
  }
}

// 注意：必须用通配符捕获，因为前端编码后的目标 URL 里含 %2F（斜杠）。
// 若用 '/proxy/:encodedUrl' 单段路由，Express 解码出斜杠后会导致路由不匹配 → 400。
const handleProxy = async (req, res) => {
  try {
    // 验证鉴权
    if (!validateProxyAuth(req)) {
      return res.status(401).json({
        success: false,
        error: '代理访问未授权：请检查密码配置或鉴权参数'
      });
    }

    // 从原始请求 URL 中截取 /proxy/ 之后的部分（不能依赖 req.path，
    // 因为挂载在 '/proxy' 上时 req.path 已不含该前缀）。
    // 注意：不能用 URL 解析，否则 %2F 会被提前解码；
    // 这里取 rawUrl 中 '?' 之前的部分手工裁剪。
    const rawUrl = req.originalUrl || req.url || '';
    const queryIndex = rawUrl.indexOf('?');
    const rawPath = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
    let encodedUrl = rawPath.replace(/^\/proxy\/?/, '');

    let targetUrl;
    try {
      targetUrl = decodeURIComponent(encodedUrl);
    } catch {
      return res.status(400).send('无效的 URL 编码');
    }

    // 某些运行时会把 %2F 直接解成 /，此时 encodedUrl 已是明文 URL
    if (!isValidUrl(targetUrl) && /^https?:\/\//i.test(encodedUrl)) {
      targetUrl = encodedUrl;
    }

    // 安全验证
    if (!isValidUrl(targetUrl)) {
      console.warn(`代理拒绝无效 URL: ${targetUrl}`);
      return res.status(400).send('无效的 URL');
    }

    log(`代理请求: ${targetUrl}`);

    // 使用原生 fetch（undici）而不是 axios：
    //  1) axios 会读取 HTTPS_PROXY/HTTP_PROXY 环境变量，在存在本地代理时会把
    //     请求发成明文 HTTP 到 443 端口，导致上游返回
    //     "The plain http request was sent to https port" (400)，图片全部取不到；
    //  2) fetch 返回 ArrayBuffer，天然二进制安全，不会破坏图片字节。
    const maxRetries = config.maxRetries;
    let retries = 0;

    const makeRequest = async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.timeout);
        try {
          return await fetch(targetUrl, {
            redirect: 'follow',
            signal: controller.signal,
            headers: {
              'User-Agent': config.userAgent,
              'Accept': '*/*',
              // 防盗链：必须带目标站点自己的 Referer（豆瓣等站点会校验）
              'Referer': buildReferer(targetUrl)
            }
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        if (retries < maxRetries) {
          retries++;
          log(`重试请求 (${retries}/${maxRetries}): ${targetUrl}`);
          return makeRequest();
        }
        throw error;
      }
    };

    const response = await makeRequest();

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.error(`代理上游返回 ${response.status}: ${errBody.slice(0, 300)}`);
      return res.status(response.status).send(errBody || `上游返回 ${response.status}`);
    }

    // 转发响应头（过滤敏感头）
    const headers = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    const sensitiveHeaders = (
      process.env.FILTERED_HEADERS ||
      'content-security-policy,cookie,set-cookie,x-frame-options,access-control-allow-origin'
    ).split(',');

    sensitiveHeaders.forEach(header => delete headers[header]);

    // 关键：fetch 已经把响应体解压并完整读入内存，
    // 上游的 content-length / content-encoding / transfer-encoding 都不再适用。
    // 若继续转发 transfer-encoding: chunked 同时又带上 content-length，
    // 会产生非法 HTTP 响应，浏览器/客户端直接解析失败。
    // 这里全部删掉，让 Node 按实际字节自行决定帧格式。
    delete headers['content-length'];
    delete headers['content-encoding'];
    delete headers['transfer-encoding'];
    delete headers['Content-Length'];
    delete headers['Content-Encoding'];
    delete headers['Transfer-Encoding'];
    res.set(headers);

    // 允许跨域取图（前端 <img> / fetch 均可用）
    res.setHeader('Access-Control-Allow-Origin', '*');

    // 以 Buffer 输出，保证二进制完整性；长度由 res.send 自动设置
    const buffer = Buffer.from(await response.arrayBuffer());
    res.status(200).send(buffer);
  } catch (error) {
    console.error('代理请求错误:', error.message);
    if (!res.headersSent) {
      res.status(500).send(`请求失败: ${error.message}`);
    }
  }
};

// 兼容两种路径：/proxy/<编码URL>，以及编码中的 %2F 被展开成多段的情况。
// Express 5 使用新版 path-to-regexp，需用 /*splat 具名通配而非裸 *。
// 另外用 regexp 中间件兜底，避免路径解析细节影响代理可用性。
app.use('/proxy', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  return handleProxy(req, res);
});

// 本地开发服务器：js/html 用协商缓存（etag 304），避免改代码后浏览器仍跑旧文件；
// 部署平台的缓存策略由 Vercel/CF/Netlify 各自控制，与此无关。
app.use(express.static(path.join(__dirname), {
  maxAge: 0,
  etag: true,
  setHeaders: (res, filePath) => {
    if (/\.(js|html)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).send('服务器内部错误');
});

app.use((req, res) => {
  res.status(404).send('页面未找到');
});

// 启动服务器
app.listen(config.port, () => {
  console.log(`服务器运行在 http://localhost:${config.port}`);
  if (config.password !== '') {
    console.log('用户登录密码已设置');
  } else {
    console.log('警告: 未设置 PASSWORD 环境变量，用户将被要求设置密码');
  }
  if (config.debug) {
    console.log('调试模式已启用');
    console.log('配置:', { ...config, password: config.password ? '******' : '' });
  }
});
