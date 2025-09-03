// worker.js - Cloudflare Workers 入口文件
import { getAssetFromKV, mapRequestToAsset } from '@cloudflare/kv-asset-handler';
import manifestJSON from '__STATIC_CONTENT_MANIFEST'; // 静态资源清单（自动生成）

// --------------------------
// 1. 复用原代理逻辑的常量与配置
// --------------------------
const MEDIA_FILE_EXTENSIONS = [
  '.mp4', '.webm', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.f4v', '.m4v', '.3gp', '.3g2', '.ts', '.mts', '.m2ts',
  '.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma', '.alac', '.aiff', '.opus',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.svg', '.avif', '.heic'
];
const MEDIA_CONTENT_TYPES = ['video/', 'audio/', 'image/'];
const __STATIC_CONTENT_MANIFEST = JSON.parse(manifestJSON); // 静态资源映射表

// --------------------------
// 2. 环境变量读取（同原逻辑）
// --------------------------
function getConfig(env) {
  const DEBUG_ENABLED = env.DEBUG === 'true';
  const CACHE_TTL = parseInt(env.CACHE_TTL || '86400');
  const MAX_RECURSION = parseInt(env.MAX_RECURSION || '5');
  
  // 解析 User-Agent 配置（默认值同原逻辑）
  let USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  ];
  try {
    if (env.USER_AGENTS_JSON) {
      const parsed = JSON.parse(env.USER_AGENTS_JSON);
      if (Array.isArray(parsed) && parsed.length > 0) USER_AGENTS = parsed;
    }
  } catch (e) {
    console.warn('解析 USER_AGENTS_JSON 失败，使用默认值:', e);
  }
  
  return { DEBUG_ENABLED, CACHE_TTL, MAX_RECURSION, USER_AGENTS, PASSWORD: env.PASSWORD };
}

// --------------------------
// 3. 复用原鉴权逻辑
// --------------------------
async function validateAuth(request, config) {
  const url = new URL(request.url);
  const authHash = url.searchParams.get('auth');
  const timestamp = url.searchParams.get('t');
  const { PASSWORD } = config;

  // 检查密码是否配置
  if (!PASSWORD) {
    console.error('未设置 PASSWORD 环境变量');
    return false;
  }

  // 计算密码 SHA-256 哈希（同原逻辑）
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(PASSWORD);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const serverHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    
    // 验证哈希匹配
    if (!authHash || authHash !== serverHash) {
      console.warn('鉴权失败：哈希不匹配');
      return false;
    }
  } catch (e) {
    console.error('计算哈希失败:', e);
    return false;
  }

  // 验证时间戳（10分钟有效期）
  if (timestamp) {
    const now = Date.now();
    const maxAge = 10 * 60 * 1000;
    if (now - parseInt(timestamp) > maxAge) {
      console.warn('鉴权失败：时间戳过期');
      return false;
    }
  }

  return true;
}

// --------------------------
// 4. 复用原代理核心逻辑
// --------------------------
async function handleProxyRequest(request, config) {
  const url = new URL(request.url);
  const { DEBUG_ENABLED, USER_AGENTS } = config;

  // 1. 验证鉴权
  const isAuthValid = await validateAuth(request, config);
  if (!isAuthValid) {
    return new Response(JSON.stringify({
      success: false,
      error: '代理访问未授权：请检查密码配置或鉴权参数'
    }), {
      status: 401,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Content-Type': 'application/json'
      }
    });
  }

  // 2. 提取目标 URL（从 /proxy/ 路径后解码）
  const encodedUrl = url.pathname.replace(/^\/proxy\//, '');
  if (!encodedUrl) {
    return new Response(JSON.stringify({ success: false, error: '无效的代理目标URL' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // 3. 解码并验证目标 URL
  let targetUrl;
  try {
    targetUrl = decodeURIComponent(encodedUrl);
    if (!targetUrl.match(/^https?:\/\//i)) {
      if (encodedUrl.match(/^https?:\/\//i)) targetUrl = encodedUrl;
      else throw new Error('目标URL非HTTP/HTTPS协议');
    }
  } catch (e) {
    console.error('解码目标URL失败:', e);
    return new Response(JSON.stringify({ success: false, error: '目标URL格式无效' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // 4. 转发请求到目标 URL（带随机 User-Agent）
  const proxyHeaders = new Headers(request.headers);
  proxyHeaders.set('User-Agent', USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]);
  proxyHeaders.delete('Cookie'); // 清除客户端 Cookie，避免跨域问题

  // 5. 发送请求并返回响应（保留原响应头）
  try {
    const proxyResponse = await fetch(targetUrl, {
      method: request.method,
      headers: proxyHeaders,
      body: request.body,
      redirect: 'follow',
      cf: { cacheTtl: config.CACHE_TTL } // 启用 Cloudflare 缓存
    });

    // 6. 处理 CORS 头
    const responseHeaders = new Headers(proxyResponse.headers);
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    responseHeaders.set('Access-Control-Allow-Headers', '*');

    return new Response(proxyResponse.body, {
      status: proxyResponse.status,
      statusText: proxyResponse.statusText,
      headers: responseHeaders
    });
  } catch (e) {
    console.error('代理请求失败:', e);
    return new Response(JSON.stringify({ success: false, error: '代理请求失败' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

// --------------------------
// 5. 静态资源处理（返回 HTML/CSS/JS 等）
// --------------------------
async function handleStaticAsset(request) {
  try {
    // 映射请求到静态资源（支持 SPA 路由，如 /s=xxx 指向 index.html）
    const mappedRequest = mapRequestToAsset(request, {
      manifest: __STATIC_CONTENT_MANIFEST,
      // SPA 路由适配：非文件路径（无后缀）或 /s=xxx 都指向 index.html
      mapRequest: (req) => {
        const url = new URL(req.url);
        if (!url.pathname.includes('.') || url.pathname.startsWith('/s=')) {
          return new Request(`${url.origin}/index.html`, req);
        }
        return req;
      }
    });

    // 从 KV 中获取静态资源（Workers 会自动上传静态文件到 KV）
    const response = await getAssetFromKV({
      request: mappedRequest,
      waitUntil: (p) => Promise.resolve(p),
      ASSET_NAMESPACE: __STATIC_CONTENT, // 自动注入的静态资源命名空间
      ASSET_MANIFEST: __STATIC_CONTENT_MANIFEST
    });

    // 处理 HTML 时注入环境变量（关键修复：ENV → env）
const contentType = response.headers.get('Content-Type') || '';
if (contentType.includes('text/html')) {
  const html = await response.text();
  const password = env.PASSWORD || ''; // 修复：将 ENV 改为 env（Wrangler 4.x 规范）
  let passwordHash = '';
  if (password) {
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(password));
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    passwordHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // 替换 HTML 中的密码占位符
  const modifiedHtml = html.replace(
    'window.__ENV__.PASSWORD = "{{PASSWORD}}";',
    `window.__ENV__.PASSWORD = "${passwordHash}"; // SHA-256 hash`
  );
  return new Response(modifiedHtml, {
    status: response.status,
    headers: response.headers
  });
}

    return response;
  } catch (e) {
    console.error('获取静态资源失败:', e);
    return new Response('404 Not Found', { status: 404 });
  }
}

// --------------------------
// 6. Workers 主入口（路由分发）
// --------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const config = getConfig(env);

    // 路由1：处理 /proxy/* 代理请求
    if (url.pathname.startsWith('/proxy/')) {
      return handleProxyRequest(request, config);
    }

    // 路由2：处理 OPTIONS 预检请求（CORS）
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // 路由3：处理静态资源请求（默认路由）
    return handleStaticAsset(request);
  }
};