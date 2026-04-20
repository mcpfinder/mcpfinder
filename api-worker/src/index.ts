import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { registerTool } from './endpoints/registerTool';
import { getToolById } from './endpoints/getToolById'; // Import the new handler
import { searchTools } from './endpoints/searchTools'; // Import the new handler
import { streamEvents } from './endpoints/streamEvents';
import { testKV } from './endpoints/testKV';
import { mcpSSE, mcpSSERequest } from './endpoints/mcpSSE';
import { mcpSSETransport } from './endpoints/mcpSSETransport';
import { mcpHTTP } from './endpoints/mcpHTTP';
import { Bindings } from './types'; // Import the new Bindings type

// Assuming Env types are defined in ./types.ts or globally for Cloudflare Workers
// Example: type Env = { Bindings: { MCP_TOOLS_KV: KVNamespace, MCP_MANIFEST_BACKUPS: R2Bucket, MCP_REGISTRY_SECRET: string } };
// Make sure Env type is correctly defined based on wrangler.toml bindings

const app = new Hono<{ Bindings: Bindings }>();

// CORS Middleware
app.use('/api/*', cors());

// Basic Error Handling
app.onError((err, c) => {
	console.error(`[Error]: ${err.message}`, err.stack);
	if (err instanceof HTTPException) {
		// Use the HTTPException status and message
		return err.getResponse();
	}
	// Default internal server error
	return c.json({ error: 'Internal Server Error', message: err.message }, 500);
});

// API v1 Router
const apiV1 = new Hono<{ Bindings: Bindings }>();

// Register endpoint handler
apiV1.post('/register', registerTool);
apiV1.get('/tools/:id', getToolById); // Connect the handler

// --- Use the actual searchTools handler ---
apiV1.get('/search', searchTools);

// SSE endpoint for real-time updates
apiV1.get('/events', streamEvents);

// Test KV endpoint
apiV1.get('/test-kv', testKV);

// MCP HTTP endpoint with SSE support
apiV1.get('/mcp', mcpHTTP);
apiV1.post('/mcp', mcpHTTP);
apiV1.options('/mcp', mcpHTTP);

// Legacy endpoints (can be removed later)
apiV1.get('/mcp/sse', mcpSSE);
apiV1.post('/mcp/sse', mcpSSERequest);

// --- REMOVE Placeholder Endpoint ---
// apiV1.get('/search', (c) => c.json({ message: 'Search tools placeholder' }));

// Mount the v1 router
app.route('/api/v1', apiV1);

// Basic root route
app.get('/', (c) => c.text('MCP Finder API'));

// Handle GET requests to /api without specific endpoint
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
    <h1>🔧 MCPfinder API</h1>
    <p>Incorrect API usage. Please use specific endpoints:</p>
    
    <div class="api-examples">
      <code>GET /api/v1/search?q=github</code>
      <code>GET /api/v1/tools/:id</code>
      <code>POST /api/v1/register</code>
      <code>GET /api/v1/events</code>
    </div>
    
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

// MCP endpoint at root level
app.get('/mcp', mcpHTTP);
app.post('/mcp', mcpHTTP);
app.options('/mcp', mcpHTTP);

// Apply CORS to MCP endpoint
app.use('/mcp', cors());

export default {
	fetch: app.fetch.bind(app),
};
