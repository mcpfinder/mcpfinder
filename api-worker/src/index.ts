import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { getSnapshotManifest, getSnapshotData, getSnapshotBrotliData } from './endpoints/snapshot';
import { Bindings } from './types';

const app = new Hono<{ Bindings: Bindings }>();

// Simple in-memory rate limiter to guard against high-volume request floods
// exhausting Worker CPU limits (CWE-770).
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 120;
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

app.use('*', async (c, next) => {
	const clientIp = c.req.header('CF-Connecting-IP') ?? 'unknown';
	const now = Date.now();
	const bucket = rateLimitBuckets.get(clientIp);
	if (!bucket || now > bucket.resetAt) {
		rateLimitBuckets.set(clientIp, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
	} else {
		bucket.count += 1;
		if (bucket.count > RATE_LIMIT_MAX_REQUESTS) {
			return c.json({ error: 'Too Many Requests' }, 429);
		}
	}
	await next();
});

app.use('/api/*', cors());

app.onError((err, c) => {
	console.error(`[Error]: ${err.message}`, err.stack);
	if (err instanceof HTTPException) {
		return err.getResponse();
	}
	return c.json({ error: 'Internal Server Error', message: err.message }, 500);
});

const apiV1 = new Hono<{ Bindings: Bindings }>();

apiV1.get('/snapshot/manifest.json', getSnapshotManifest);
apiV1.get('/snapshot/data.sqlite.gz', getSnapshotData);
apiV1.get('/snapshot/data.sqlite.br', getSnapshotBrotliData);

const deprecatedMcpHandler = (c: any) => {
  return c.json({
    error: 'Deprecated',
    message: 'The HTTP MCP endpoint at /mcp is deprecated to prevent API fragmentation. Please use the local stdio server via `npx -y @mcpfinder/server` to access the full toolset. See https://mcpfinder.dev for details.',
  }, 410);
};

apiV1.all('/mcp', deprecatedMcpHandler);
apiV1.all('/mcp/sse', deprecatedMcpHandler);

app.route('/api/v1', apiV1);
app.all('/mcp', deprecatedMcpHandler);

app.get('/', (c) =>
  c.text(
    'MCPfinder support endpoints. The canonical MCP interface is the local stdio server via `npx -y @mcpfinder/server`.',
  ),
);

app.get('/api', (c) => {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MCPfinder API - Invalid Usage</title>
  <style>
    body { 
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; 
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      margin: 0;
      padding: 40px 20px;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      background: rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(10px);
      border-radius: 16px;
      padding: 40px;
      text-align: center;
      max-width: 500px;
      border: 1px solid rgba(255, 255, 255, 0.2);
    }
    h1 { font-size: 2rem; margin-bottom: 1rem; }
    p { font-size: 1.1rem; line-height: 1.6; margin-bottom: 1.5rem; }
    .api-examples {
      background: rgba(0, 0, 0, 0.2);
      border-radius: 8px;
      padding: 1rem;
      margin: 1.5rem 0;
      text-align: left;
    }
    .api-examples code {
      display: block;
      margin: 0.5rem 0;
      color: #22d3ee;
      font-family: 'Monaco', monospace;
      font-size: 0.9rem;
    }
    .redirect-info {
      font-size: 0.9rem;
      opacity: 0.8;
      margin-top: 2rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>MCPfinder Support API</h1>
    <p>This Worker serves support endpoints only. Use the local stdio server via <code>npx -y @mcpfinder/server</code> for MCPfinder itself.</p>
    
    <div class="api-examples">
      <code>GET /api/v1/snapshot/manifest.json</code>
      <code>GET /api/v1/snapshot/data.sqlite.gz?sha=&lt;manifest sha256&gt;</code>
      <code>GET /api/v1/snapshot/data.sqlite.br?sha=&lt;manifest brotli.sha256&gt;</code>
    </div>
    <p>Take both <code>sha</code> values from the manifest; <code>data.sqlite.br</code> requires one, and is only published when the manifest carries a <code>brotli</code> block.</p>
    
    <p>For full documentation and examples, visit our main website.</p>
    
    <div class="redirect-info">
      Redirecting to mcpfinder.dev in <span id="countdown">2</span> seconds...
    </div>
  </div>
  
  <script>
    let countdown = 2;
    const countdownEl = document.getElementById('countdown');
    
    const timer = setInterval(() => {
      countdown--;
      countdownEl.textContent = countdown;
      
      if (countdown <= 0) {
        clearInterval(timer);
        window.location.href = 'https://mcpfinder.dev';
      }
    }, 1000);
  </script>
</body>
</html>`;
  
  return c.html(html);
});

export default {
	fetch: app.fetch.bind(app),
};
