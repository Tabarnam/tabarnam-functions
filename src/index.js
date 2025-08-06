// src/index.js
const { app } = require('@azure/functions');

app.http('xai', {
  methods: ['GET', 'POST', 'OPTIONS'],
  authLevel: 'function',
  handler: async (request, context) => {
    context.log('HTTP trigger function processed a request.');

    const origin = request.headers.get('origin') || '*';
    context.res.set('Access-Control-Allow-Origin', origin);
    context.res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    context.res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (request.method === 'OPTIONS') {
      return { status: 204 };
    }

    if (request.method !== 'POST') {
      return { status: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    const body = await request.json();
    const { query } = body;
    if (!query || typeof query !== 'string') {
      return { status: 400, body: JSON.stringify({ error: 'Missing or invalid query' }) };
    }

    try {
      const { callXAI, buildPrompt } = require('./xai/index.js');
      const prompt = buildPrompt(query);
      const companies = await callXAI(prompt);
      context.log(`✅ IMPORT SUCCESS: ${companies.length} unique companies via xAI`);
      return {
        status: 200,
        headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60' },
        body: JSON.stringify({ companies }),
      };
    } catch (error) {
      context.log('IMPORT ERROR:', error.message);
      return { status: 500, body: JSON.stringify({ error: error.message || 'Unknown error' }) };
    }
  },
});

app.setup({
  enableHttpStream: true,
});