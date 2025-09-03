// worker.js - LibreTV Workers 入口文件（无需修改，直接使用）
import { getAssetFromKV, mapRequestToAsset } from '@cloudflare/kv-asset-handler';
import manifestJSON from '__STATIC_CONTENT_MANIFEST';

// 1. 常量定义（视频/音频格式支持）
const MEDIA_EXTENSIONS = ['.mp4', '.webm', '.mkv', '.avi', '.mp3', '.flac', '.jpg', '.png'];
const __STATIC_CONTENT_MANIFEST = JSON.parse(manifestJSON);

// 2. 读取环境变量配置
function getConfig(env) {
  return {
    PASSWORD: env.PASSWORD || '',
    CACHE_TTL: parseInt(env.CACHE_TTL || '86400'),
    MAX_RECURSION: parseInt(env.MAX_RECURSION || '5'),
    DEBUG: env.DEBUG === 'true',
    USER_AGENTS: env.USER_AGENTS_JSON ? JSON.parse(env.USER_AGENTS_JSON) : [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
    ]
  };
}

// 3. 代理鉴权逻辑（基于 PASSWORD 哈希验证）
async function validateAuth(request, config) {
  if (!config.PASSWORD) return false;
  const url = new URL(request.url);
  const authHash = url.searchParams.get('auth');
  const timestamp = url.searchParams.get('t');

  // 计算密码 SHA-256 哈希
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(config.PASSWORD));
  const serverHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

  // 验证哈希和时间戳（10分钟有效期）
  if (authHash !== serverHash) return false;
  if (timestamp && Date.now() - parseInt(timestamp) > 10 * 60 * 1000) return false;
  return true;
}

// 4. 代理请求处理（转发视频流）
async function handleProxy(request, config) {
  if (!await validateAuth(request, config)) {
    return new Response(JSON.stringify({ success: false, error: '未授权' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // 提取并解码目标 URL
  const url = new URL(request.url);
  const encodedUrl = url.pathname.replace(/^\/proxy\//, '');
  if (!encodedUrl) return new Response(JSON.stringify({ success: false, error: '无效 URL' }), { status: 400 });
  const targetUrl = decodeURIComponent(encodedUrl);

  // 转发请求（带随机 User-Agent）
  const headers = new Headers(request.headers);
  headers.set('User-Agent', config.USER_AGENTS[Math.floor(Math.random() * config.USER_AGENTS.length)]);
  headers.delete('Cookie');

  try {
    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'follow',
      cf: { cacheTtl: config.CACHE_TTL }
    });
    const resHeaders = new Headers(response.headers);
    resHeaders.set('Access-Control-Allow-Origin', '*');
    return new Response(response.body, { status: response.status, headers: resHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: '代理失败' }), { status: 500 });
  }
}

// 5. 静态资源处理（返回 HTML/CSS/JS 等）
async function handleStatic(request) {
  try {
    // 适配 SPA 路由（如 /s=xxx 指向 index.html）
    const mappedRequest = mapRequestToAsset(request, {
      manifest: __STATIC_CONTENT_MANIFEST,
      mapRequest: (req) => {
        const url = new URL(req.url);
        if (!url.pathname.includes('.') || url.pathname.startsWith('/s=')) {
          return new Request(`${url.origin}/index.html`, req);
        }
        return req;
      }
    });

    // 从 KV 读取静态资源
    const response = await getAssetFromKV({
      request: mappedRequest,
      waitUntil: (p) => Promise.resolve(p),
      ASSET_NAMESPACE: __STATIC_CONTENT,
      ASSET_MANIFEST: __STATIC_CONTENT_MANIFEST
    });

    // 注入密码哈希到 HTML（适配前端鉴权）
    const contentType = response.headers.get('Content-Type') || '';
    if (contentType.includes('text/html')) {
      const html = await response.text();
      const config = getConfig(env); // 关键：Wrangler 4.x 用 env 而非 ENV
      let passwordHash = '';
      if (config.PASSWORD) {
        const encoder = new TextEncoder();
        const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(config.PASSWORD));
        passwordHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
      }
      const modifiedHtml = html.replace('window.__ENV__.PASSWORD = "{{PASSWORD}}";', `window.__ENV__.PASSWORD = "${passwordHash}";`);
      return new Response(modifiedHtml, { status: response.status, headers: response.headers });
    }

    return response;
  } catch (e) {
    return new Response('404 Not Found', { status: 404 });
  }
}

// 6. 主路由分发（入口）
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const config = getConfig(env);

    // 处理 OPTIONS 预检请求（CORS）
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

    // 处理代理请求（/proxy/*）
    if (url.pathname.startsWith('/proxy/')) {
      return handleProxy(request, config);
    }

    // 处理静态资源（默认路由）
    return handleStatic(request);
  }
};
