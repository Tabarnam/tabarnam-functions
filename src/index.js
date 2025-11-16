// src/index.js
import { app } from '@azure/functions';

app.http('xai', {
  methods: ['GET', 'POST', 'OPTIONS'],
  authLevel: 'function',
});

app.setup({
  enableHttpStream: true,
});