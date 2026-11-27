const SYSTEM_PROMPT = `Сен — Super-Ong, логистика ва бизнес бошқаруви бўйича ўта ақлли шахсий AI-ассистентсан.
Сенинг асосий вазифанг:
1. Барча ўтган суҳбатлар, юклар, маршрутлар, мижозлар ва режаларни хотирада сақлаш ва уларга таяниб фойдаланувчига аниқ, амалий таклифлар киритиш.
2. Қисқа, лўнда, ёлғонсиз ва фойдали жавоб бериш.
3. Ҳар доим ўтган контекстни ҳисобга олиб, кейинги энг тўғри қадамни тавсия қилиш.`;

async function neonQuery(dbUrl, query, params = []) {
  const parsed = new URL(dbUrl);
  const endpoint = `https://${parsed.hostname}/sql`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Neon-Connection-String': dbUrl
    },
    body: JSON.stringify({ query, params })
  });
  return res.json();
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(HTML_UI);
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      let userId = 'owner';
      let userMessage = '';
      let isTelegram = false;
      let chatId = null;

      if (body.message && typeof body.message === 'object' && body.message.chat) {
        isTelegram = true;
        chatId = body.message.chat.id;
        userId = `tg_${chatId}`;
        userMessage = body.message.text || '';
        if (!userMessage) return res.status(200).send('OK');
      } else {
        userMessage = body.message || '';
      }

      let longTermContext = '';
      if (process.env.NEON_DATABASE_URL) {
        await neonQuery(
          process.env.NEON_DATABASE_URL,
          `CREATE TABLE IF NOT EXISTS memory_logs (id SERIAL PRIMARY KEY, user_id TEXT, role TEXT, content TEXT, created_at TIMESTAMP DEFAULT NOW())`
        );
        const dbRes = await neonQuery(
          process.env.NEON_DATABASE_URL,
          `SELECT role, content FROM memory_logs WHERE user_id = $1 ORDER BY id DESC LIMIT 20`,
          [userId]
        );
        if (dbRes.rows && dbRes.rows.length > 0) {
          longTermContext = dbRes.rows.reverse().map(r => `${r.role}: ${r.content}`).join('\n');
        }
      }

      let recentHistory = [];
      if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
        const redisRes = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/lrange/chat:${userId}/0/15`, {
          headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
        });
        const redisData = await redisRes.json();
        recentHistory = (redisData.result || []).reverse().map(item => {
          try { return JSON.parse(item); } catch { return null; }
        }).filter(Boolean);
      }

      const messages = [
        { role: 'system', content: `${SYSTEM_PROMPT}\n\nЎтган доимий хотира архиви:\n${longTermContext}` },
        ...recentHistory,
        { role: 'user', content: userMessage }
      ];

      const aiRes = await fetch('https://mistral.ai', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`
        },
        body: JSON.stringify({
          model: 'mistral-large-latest',
          messages: messages,
          temperature: 0.4
        })
      });

      const aiData = await aiRes.json();
      const reply = aiData.choices?.?.message?.content || aiData.message || 'Жавоб олишда хатолик юз берди.';

      if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
        await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/lpush/chat:${userId}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
          body: JSON.stringify(JSON.stringify({ role: 'user', content: userMessage }))
        });
        await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/lpush/chat:${userId}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
          body: JSON.stringify(JSON.stringify({ role: 'assistant', content: reply }))
        });
      }

      if (process.env.NEON_DATABASE_URL) {
        await neonQuery(
          process.env.NEON_DATABASE_URL,
          `INSERT INTO memory_logs (user_id, role, content) VALUES ($1, 'user', $2)`,
          [userId, userMessage]
        );
        await neonQuery(
          process.env.NEON_DATABASE_URL,
          `INSERT INTO memory_logs (user_id, role, content) VALUES ($1, 'assistant', $2)`,
          [userId, reply]
        );
      }

      if (isTelegram && process.env.TELEGRAM_BOT_TOKEN) {
        await fetch(`https://telegram.org{process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: reply })
        });
        return res.status(200).send('OK');
      }

      return res.status(200).json({ reply });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).send('Method Not Allowed');
}

const HTML_UI = `<!DOCTYPE html>
<html lang="uz">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Super-Ong AI</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; display: flex; flex-direction: column; height: 100vh; }
    header { padding: 14px 18px; background: #1e293b; border-bottom: 1px solid #334155; font-weight: 700; display: flex; justify-content: space-between; align-items: center; }
    span.badge { font-size: 12px; background: #10b981; color: #022c22; padding: 3px 8px; border-radius: 999px; }
    #chat { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    .msg { max-width: 82%; padding: 12px 14px; border-radius: 14px; line-height: 1.5; white-space: pre-wrap; }
    .user { align-self: flex-end; background: #2563eb; color: #fff; }
    .bot { align-self: flex-start; background: #1e293b; border: 1px solid #334155; }
    form { display: flex; gap: 8px; padding: 12px; background: #1e293b; border-top: 1px solid #334155; }
    input { flex: 1; padding: 12px; border-radius: 10px; border: 1px solid #475569; background: #0f172a; color: #fff; font-size: 16px; }
    button { padding: 12px 18px; border-radius: 10px; border: none; background: #10b981; color: #022c22; font-weight: 700; cursor: pointer; }
  </style>
</head>
<body>
  <header>
    <div>🧠 Super-Ong AI</div>
    <span class="badge">24/7 Хотира Ёниқ</span>
  </header>
  <div id="chat">
    <div class="msg bot">Салом! Мен Super-Ong AI. Барча ўтган суҳбатлар, логистика режалари ва маълумотларни Redis ва Neon хотирасида сақлайман. Нимадан бошлаймиз?</div>
  </div>
  <form id="form">
    <input id="input" placeholder="Хабар ёки логистика топшириғини ёзинг..." autocomplete="off" required />
    <button type="submit">Юбориш</button>
  </form>
  <script>
    const chat = document.getElementById('chat');
    const form = document.getElementById('form');
    const input = document.getElementById('input');
    function add(text, cls) {
      const div = document.createElement('div');
      div.className = 'msg ' + cls;
      div.textContent = text;
      chat.appendChild(div);
      chat.scrollTop = chat.scrollHeight;
      return div;
    }
    form.onsubmit = async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      add(text, 'user');
      const loading = add('Ўйлаяпман ва хотирани текширяпман...', 'bot');
      try {
        const res = await fetch('/api', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text })
        });
        const data = await res.json();
        loading.textContent = data.reply || data.error || 'Хатолик юз берди';
      } catch (err) {
        loading.textContent = 'Алоқа хатоси: ' + err.message;
      }
    };
  </script>
</body>
</html>`;
