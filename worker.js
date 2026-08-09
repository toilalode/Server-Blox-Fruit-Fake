/**
 * Blox Fruit Fake - Server API (Cloudflare Worker)
 * ------------------------------------------------
 * Cần bind trong wrangler.toml (hoặc Settings > Variables/Bindings):
 *   - KV namespace  tên "GAME_DATA"        (đã có từ trước)
 *   - Durable Object tên "ROOM"  class "GameRoom"
 *
 * Endpoint:
 *   GET  /check-name?name=xxx
 *   POST /register-name          body: { name }
 *   POST /save                   body: { name, data }
 *   GET  /load?name=xxx
 *   POST /leaderboard/submit     body: { name, level, gold, bossKillCount }
 *   GET  /leaderboard/top?limit=50
 *   GET  /room/:id/ws , /room/:id/count  -> multiplayer (Durable Object)
 *
 * CHỐNG SỬA SỐ LIỆU (anti-cheat) — thiết kế: server (KV) LUÔN là nguồn sự thật duy nhất cho save data.
 * Export/Import ở client chỉ mã hóa TÊN người chơi (không mang số liệu) — khi Import, client luôn gọi
 * GET /load lấy đúng bản mới nhất server đang giữ và áp dụng thẳng, bỏ qua bất kỳ số liệu nào người
 * chơi có thể đã tự sửa (qua DevTools hay cách khác) trên máy đang giữ export code. Vì vậy /save chính
 * là điểm duy nhất ghi số liệu vào server — không có endpoint nào cho client tự đẩy số liệu "giả" vào
 * mà không đi qua đường save bình thường của game.
 *
 * CORS: cho phép gọi từ bất kỳ domain nào.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function normName(name) {
  return (name || '').trim().toLowerCase();
}

/* ============================================================
   DURABLE OBJECT: GameRoom — 1 instance = 1 phòng chơi multiplayer
   ============================================================ */
export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // Map<WebSocket, {id, name, x, y, dir, anim}>
    this.sessions = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);

    // GET /count -> số người đang trong phòng (không cần mở WebSocket)
    if (url.pathname.endsWith('/count') && request.method === 'GET') {
      return json({ count: this.sessions.size });
    }

    // GET /ws -> nâng cấp WebSocket
    if (url.pathname.endsWith('/ws')) {
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return json({ error: 'Yêu cầu này phải là WebSocket upgrade.' }, 426);
      }
      const name = (url.searchParams.get('name') || 'Ẩn danh').trim().slice(0, 18) || 'Ẩn danh';
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.handleSession(server, name);
      return new Response(null, { status: 101, webSocket: client });
    }

    return json({ error: 'Không tìm thấy endpoint trong room.' }, 404);
  }

  handleSession(ws, name) {
    ws.accept();
    const id = 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    const info = { id, name, x: 0, y: 0, dir: 1, anim: 'idle' };
    this.sessions.set(ws, info);

    // Gửi cho người mới: id của họ + danh sách người đang có sẵn trong phòng
    const others = [...this.sessions.values()].filter(p => p.id !== id);
    this.safeSend(ws, { t: 'welcome', selfId: id, players: others });

    // Báo cho mọi người khác: có người mới vào
    this.broadcast({ t: 'join', id, name }, ws);

    ws.addEventListener('message', (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch (err) { return; }
      if (!msg || typeof msg !== 'object') return;

      switch (msg.t) {
        case 'move': {
          info.x = Number(msg.x) || 0;
          info.y = Number(msg.y) || 0;
          info.dir = msg.dir || info.dir;
          info.anim = msg.anim || info.anim;
          this.broadcast({ t: 'state', id, x: info.x, y: info.y, dir: info.dir, anim: info.anim }, ws);
          break;
        }
        case 'action': {
          // Hành động tức thời (đánh, skill, nhặt fruit, dùng kraken...) — chỉ chuyển tiếp, không lưu state.
          const { kind, ...extra } = msg;
          this.broadcast({ t: 'action', id, kind, ...extra }, ws);
          break;
        }
        case 'chat': {
          const text = String(msg.text || '').slice(0, 200);
          if (!text) return;
          this.broadcast({ t: 'chat', id, name, text }, null); // chat thì gửi lại cho cả người gửi luôn
          break;
        }
        case 'ping': {
          this.safeSend(ws, { t: 'pong' });
          break;
        }
      }
    });

    const onClose = () => {
      this.sessions.delete(ws);
      this.broadcast({ t: 'leave', id }, null);
    };
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', onClose);
  }

  safeSend(ws, data) {
    try { ws.send(JSON.stringify(data)); } catch (err) { /* socket có thể đã đóng */ }
  }

  // Gửi tới tất cả session trong phòng, trừ `exclude` (nếu có). exclude=null nghĩa là gửi cho tất cả kể cả người gửi.
  broadcast(data, exclude) {
    const payload = JSON.stringify(data);
    for (const [ws] of this.sessions) {
      if (exclude && ws === exclude) continue;
      try { ws.send(payload); } catch (err) { this.sessions.delete(ws); }
    }
  }
}

/* ============================================================
   MAIN WORKER
   ============================================================ */
// Kiểm tra schema + range cơ bản trước khi ghi vào KV qua /save — chặn số liệu bất thường
// (level/gold/... vượt giới hạn game cho phép) được đẩy lên server, dù có sửa tay ở client thế nào.
function validateSaveDataBasic(data) {
  if (!data || typeof data !== 'object') throw new Error('Cấu trúc dữ liệu sai (không phải object).');
  const numFields = ['level', 'exp', 'gold', 'maxHp', 'atkDamage', 'statPoints'];
  for (const k of numFields) {
    if (data[k] !== undefined && typeof data[k] !== 'number') throw new Error('Trường "' + k + '" sai kiểu dữ liệu.');
  }
  const limits = { level: [1, 9999], gold: [0, 1e12], exp: [0, 1e9], statPoints: [0, 100000], maxHp: [1, 1e7], atkDamage: [0, 1e7] };
  for (const k in limits) {
    if (data[k] === undefined) continue;
    const [min, max] = limits[k];
    if (Number.isNaN(data[k]) || data[k] < min || data[k] > max) throw new Error('Trường "' + k + '" vượt giới hạn cho phép.');
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      // ---- GET /check-name?name=xxx ----
      if (path === '/check-name' && request.method === 'GET') {
        const name = normName(url.searchParams.get('name'));
        if (!name) return json({ error: 'Thiếu tham số name' }, 400);
        const existing = await env.GAME_DATA.get('name:' + name);
        return json({ taken: !!existing });
      }

      // ---- POST /register-name  body: { name } ----
      if (path === '/register-name' && request.method === 'POST') {
        const body = await request.json();
        const rawName = (body.name || '').trim();
        const name = normName(rawName);
        if (!name) return json({ error: 'Tên không hợp lệ' }, 400);
        const existing = await env.GAME_DATA.get('name:' + name);
        if (existing) return json({ ok: false, error: 'Tên này đã có người dùng.' }, 409);
        await env.GAME_DATA.put('name:' + name, JSON.stringify({ registeredAt: Date.now() }));
        return json({ ok: true });
      }

      // ---- POST /save  body: { name, data } ----
      // Đây là ĐIỂM DUY NHẤT ghi số liệu save vào server — validate range/kiểu dữ liệu ngay tại đây để
      // chặn số liệu bất thường (level/gold vượt giới hạn game...) được lưu vào KV, dù client có bị sửa thế nào.
      if (path === '/save' && request.method === 'POST') {
        const body = await request.json();
        const name = normName(body.name);
        if (!name) return json({ error: 'Thiếu tên phiên' }, 400);
        const data = body.data || {};
        try { validateSaveDataBasic(data); } catch (err) { return json({ error: 'Dữ liệu save bất thường, bị từ chối: ' + err.message }, 400); }
        await env.GAME_DATA.put('save:' + name, JSON.stringify(data));
        return json({ ok: true, savedAt: Date.now() });
      }

      // ---- GET /load?name=xxx ----
      if (path === '/load' && request.method === 'GET') {
        const name = normName(url.searchParams.get('name'));
        if (!name) return json({ error: 'Thiếu tham số name' }, 400);
        const raw = await env.GAME_DATA.get('save:' + name);
        return json({ data: raw ? JSON.parse(raw) : null });
      }

      // ---- POST /leaderboard/submit  body: { name, level, gold, bossKillCount } ----
      if (path === '/leaderboard/submit' && request.method === 'POST') {
        const body = await request.json();
        const name = normName(body.name);
        if (!name) return json({ error: 'Thiếu tên' }, 400);
        const entry = {
          name: (body.name || '').trim(),
          level: Number(body.level) || 1,
          gold: Number(body.gold) || 0,
          bossKillCount: Number(body.bossKillCount) || 0,
          updatedAt: Date.now(),
        };
        await env.GAME_DATA.put('lb:' + name, JSON.stringify(entry));
        return json({ ok: true });
      }

      // ---- GET /leaderboard/top?limit=50 ----
      if (path === '/leaderboard/top' && request.method === 'GET') {
        const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10)));
        // KV không hỗ trợ query/sort — liệt kê toàn bộ key "lb:" rồi sort thủ công.
        // Với lượng người chơi lớn (>1000), nên chuyển sang lưu 1 bản tổng hợp thay vì list() mỗi lần.
        let cursor;
        const entries = [];
        do {
          const page = await env.GAME_DATA.list({ prefix: 'lb:', cursor, limit: 1000 });
          for (const k of page.keys) {
            const raw = await env.GAME_DATA.get(k.name);
            if (raw) { try { entries.push(JSON.parse(raw)); } catch (e) {} }
          }
          cursor = page.cursor;
          if (page.list_complete) break;
        } while (cursor);
        entries.sort((a, b) => (b.level - a.level) || (b.gold - a.gold));
        return json({ list: entries.slice(0, limit) });
      }

      // ---- ROOM: /room/:roomId/ws  và  /room/:roomId/count -> route sang Durable Object ----
      const roomMatch = path.match(/^\/room\/([a-zA-Z0-9_-]+)\/(ws|count)$/);
      if (roomMatch) {
        const roomId = roomMatch[1];
        const id = env.ROOM.idFromName(roomId);
        const stub = env.ROOM.get(id);
        return stub.fetch(request);
      }

      return json({ error: 'Không tìm thấy endpoint: ' + path }, 404);
    } catch (err) {
      return json({ error: 'Lỗi server: ' + err.message }, 500);
    }
  },
};
