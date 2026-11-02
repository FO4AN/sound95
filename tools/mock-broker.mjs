// Runs worker/src/index.js locally against the mock SoundCloud server.
import { createServer } from 'node:http';
import worker from '../worker/src/index.js';

const env = {
  SOUND95_CLIENT_ID: 'mock-id',
  SOUND95_CLIENT_SECRET: 'mock-secret',
  AUTH_BASE: process.env.MOCK_AUTH_BASE || 'http://127.0.0.1:17996',
};
const port = Number(process.env.BROKER_PORT || 17997);

createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const response = await worker.fetch(new Request(`http://127.0.0.1:${port}${req.url}`, {
    method: req.method,
    body: hasBody ? Buffer.concat(chunks) : undefined,
  }), env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(await response.text());
}).listen(port, '127.0.0.1', () => console.log(`broker on ${port}`));
