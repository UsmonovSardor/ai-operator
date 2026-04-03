const express = require('express');
const OpenAI = require('openai');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const buildSystemPrompt = () => `
You are ${process.env.OPERATOR_NAME || 'Aria'}, a professional AI voice operator.
Company: ${process.env.COMPANY_NAME || 'Our Company'}
Role: ${process.env.OPERATOR_ROLE || 'Customer Support Specialist'}

CORE BEHAVIOR:
- Speak naturally, warmly, and professionally like a skilled human operator
- Keep responses SHORT and CONVERSATIONAL (1-3 sentences max for voice)
- Never say you are an AI unless directly asked
- Use natural speech patterns: "Of course!", "Great question!", "Let me help you with that"
- Avoid bullet points - speak in flowing sentences

Language: Respond in the SAME language the customer speaks (Uzbek, Russian, or English).

Company Info:
${process.env.COMPANY_INFO || 'We provide excellent customer service and support.'}
`.trim();

const activeCalls = new Map();
const callLogs = [];

// VAPI Custom LLM Endpoint
app.post('/chat/completions', async (req, res) => {
  try {
    const { messages, stream, temperature, max_tokens } = req.body;
    const systemMessage = { role: 'system', content: buildSystemPrompt() };
    const fullMessages = messages[0]?.role === 'system' ? messages : [systemMessage, ...messages];

    const requestParams = {
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      messages: fullMessages,
      temperature: temperature || 0.7,
      max_tokens: max_tokens || 300,
    };

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const streamResponse = await openai.chat.completions.create({ ...requestParams, stream: true });
      for await (const chunk of streamResponse) {
        if (res.destroyed) break;
        res.write('data: ' + JSON.stringify(chunk) + '\n\n');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      const response = await openai.chat.completions.create(requestParams);
      res.json(response);
    }
  } catch (error) {
    console.error('[LLM Error]', error.message);
    res.status(500).json({ error: { message: error.message } });
  }
});

// VAPI Webhook
app.post('/webhook', async (req, res) => {
  const { type, call } = req.body;
  console.log('[Webhook] Event:', type);

  if (type === 'call-started') {
    activeCalls.set(call.id, {
      id: call.id, startTime: new Date().toISOString(),
      callerNumber: call.customer?.number || 'Unknown', status: 'active', transcript: []
    });
  } else if (type === 'call-ended') {
    const c = activeCalls.get(call?.id);
    if (c) {
      c.status = 'ended';
      c.endTime = new Date().toISOString();
      c.duration = Math.round((Date.now() - new Date(c.startTime)) / 1000);
      c.endReason = call.endedReason || 'unknown';
      callLogs.push({ ...c });
      activeCalls.delete(call.id);
    }
  }
  res.json({ success: true });
});

app.get('/api/stats', (req, res) => {
  res.json({
    totalCalls: callLogs.length,
    activeCalls: activeCalls.size,
    avgDuration: callLogs.length > 0 ? Math.round(callLogs.reduce((s, c) => s + (c.duration || 0), 0) / callLogs.length) : 0,
    operatorName: process.env.OPERATOR_NAME || 'Aria',
    companyName: process.env.COMPANY_NAME || 'Our Company',
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    uptime: Math.round(process.uptime()),
  });
});

app.get('/api/calls', (req, res) => {
  res.json({ active: Array.from(activeCalls.values()), history: callLogs.slice(-50).reverse() });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString(), version: '1.0.0' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('AI Operator Server running on port', PORT);
});
