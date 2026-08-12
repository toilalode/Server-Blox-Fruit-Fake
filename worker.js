/**
 * Blox Fruit Fake - Server API (Cloudflare Worker)
 * ------------------------------------------------
 * Cần bind trong wrangler.toml (hoặc Settings > Variables/Bindings):
 *   - KV namespace  tên "GAME_DATA"        (đã có từ trước)
 *   - Durable Object tên "ROOM"  class "GameRoom"      (multiplayer + chat theo phòng)
 *   - Durable Object tên "GLOBAL" class "GlobalState"  (MỚI — sự kiện toàn server, trade, DM/nhóm chat)
 *   - Secret  tên "ADMIN_KEY"  -> mật khẩu admin thật, CHỈ SERVER BIẾT
 *     Set bằng: wrangler secret put ADMIN_KEY   (hoặc Dashboard > Settings > Variables > Secret)
 *
 * Endpoint cũ: /check-name /register-name /save /load /leaderboard/submit /leaderboard/top
 *              /room/:id/ws /room/:id/count  (multiplayer + chat phòng, xem class GameRoom)
 *
 * Endpoint MỚI - Admin (xác thực bằng ADMIN_KEY, KHÔNG dựa vào tên phiên client):
 *   POST /admin/verify        body: { key }                          -> { ok }
 *   POST /admin/command       body: { key, cmd, args }                -> { ok, result } — xem CÁC LỆNH ADMIN bên dưới
 *   POST /admin/event/set     body: { key, event: 'x50'|'hidden', on }-> bật/tắt sự kiện TOÀN SERVER
 *   GET  /event/status                                                -> { x50:bool, hidden:bool } (public, ai cũng gọi được để hiển thị banner)
 *   GET  /admin/log?key=xxx&limit=100 -> lịch sử lệnh admin gần nhất (chỉ admin thật xem được): ai dùng lệnh gì, khi nào
 *
 * Endpoint MỚI - Trade (2 kiểu: có xác nhận 2 chiều, và gửi tặng thẳng):
 *   POST /trade/gift          body: { fromName, toName, items }       -> chuyển thẳng item, không cần xác nhận
 *   POST /trade/offer/create  body: { fromName, toName, offerItems }  -> tạo đề nghị trao đổi, chờ 2 bên xác nhận
 *   POST /trade/offer/respond body: { offerId, name, accept, counterItems } -> chấp nhận/từ chối/đưa đề nghị ngược lại
 *   GET  /trade/offer/list?name=xxx                                   -> danh sách đề nghị trade đang chờ liên quan tới `name`
 *   (Toàn bộ logic hoán đổi item được xử lý atomic trong Durable Object GlobalState, tránh race condition
 *    2 người trade cùng lúc, và tự validate item claimed có thật trong save data của người gửi hay không.)
 *
 * Endpoint MỚI - Direct Message & Group Chat (lưu lịch sử KV, không cần WebSocket vẫn dùng được — poll định kỳ):
 *   POST /chat/dm/send        body: { fromName, toName, text, mode }  -> mode: 'moderated'|'unmoderated'|'anonymous'
 *   GET  /chat/dm/history?a=NAME&b=NAME&limit=50
 *   POST /chat/group/create   body: { ownerName, groupName, members[] } -> { groupId }
 *   POST /chat/group/send     body: { groupId, fromName, text, mode }
 *   GET  /chat/group/history?groupId=xxx&limit=50
 *   GET  /chat/group/list?name=xxx                                    -> nhóm mà `name` là thành viên
 *
 * KIỂM DUYỆT (mode='moderated'): lọc từ cấm cơ bản trên server trước khi lưu/broadcast — không thay được
 * bằng client vì client có thể bị sửa để bỏ qua bộ lọc. mode='unmoderated'/'anonymous' bỏ qua lọc từ cấm
 * nhưng 'anonymous' che tên người gửi (thay bằng "Ẩn danh#xxxx" cố định theo tên thật, để chặn được nếu
 * cần nhưng người khác không biết là ai).
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

// Bộ lọc từ cấm cho chat 'moderated' — chỉ chặn được ở SERVER vì client có thể bị sửa để bypass.
// Danh sách gốc (không dấu, chữ thường) — so khớp sau khi ĐÃ chuẩn hoá text đầu vào (xem normalizeForFilter),
// nên 1 từ ở đây tự động bắt được mọi biến thể CHÍNH TẢ (có dấu, viết hoa, chèn ký tự thừa: đ.m, v-c-l...)
// KHÔNG CẦN liệt kê riêng — vd đã có "dit" thì "địt/Đ.I.T/DJT" đều tự khớp. Danh sách dưới đây chỉ cần bổ
// sung các GỐC TỪ KHÁC NHAU: viết tắt, từ láy, và cụm ghép thông dụng không tự suy ra được từ gốc đã có.
const BANNED_WORDS = [
  // ---- Viết tắt phổ biến ----
  'dm','vcl','vl','cc','clm','loz','lol','dmm','vlon','vloz','djt','dcm','dcmm',
  // ---- Từ gốc + biến âm/từ láy thường gặp ----
  'du ma','deo','ngu','dit','lon','cac','bu','cho','deu','dcl','ditme','dume','vailon',
  // ---- Cụm ghép thông dụng (gốc + từ đi kèm hay bị né tránh riêng lẻ) ----
  'oc cho','thang cho','con cho','con lon','thang ngu','ngu vai','ngu nhu cho','do ngu',
  'dit me','dit con me','dit cha','thang dit','con dit','lon me','vai ca lon',
  // ---- Bổ sung theo yêu cầu (2024) ----
  'kid','tuat',
];
// Bỏ dấu tiếng Việt + hạ chữ thường, để "Đ.M", "đéo", "ĐEO" đều quy về cùng 1 dạng so khớp.
function stripVietnameseDiacritics(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd');
}
// Chuẩn hoá CHỈ để PHÁT HIỆN (không dùng bản này để hiển thị): hạ thường, bỏ dấu, bỏ mọi ký tự
// không phải chữ/số/khoảng trắng (để bắt kiểu né tránh "đ.m", "v-c-l", "vcl123").
function normalizeForFilter(s) {
  return stripVietnameseDiacritics(s.toLowerCase()).replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}
function moderateText(text) {
  // Xây bản chuẩn hoá + bảng ánh xạ vị trí ký tự đồng thời (ký tự theo ký tự, không co gọn khoảng trắng ở đây
  // để bảng ánh xạ luôn đúng 1-1) — khoảng trắng liên tiếp được co gọn ngay trong khi build thay vì gọi lại
  // normalizeForFilter trên chuỗi đầy đủ.
  let norm = '', map = [];
  let lastWasSpace = true; // coi như bắt đầu bằng "space" để tự động bỏ khoảng trắng/ký tự rác ở đầu chuỗi
  for (let i = 0; i < text.length; i++) {
    const c = stripVietnameseDiacritics(text[i].toLowerCase());
    if (/[a-z0-9]/.test(c)) { norm += c; map.push(i); lastWasSpace = false; }
    else if (/\s/.test(c)) { if (!lastWasSpace) { norm += ' '; map.push(i); lastWasSpace = true; } }
    // ký tự khác (dấu câu, emoji...) bị bỏ hẳn khỏi `norm`, không chiếm vị trí trong map
  }
  norm = norm.trimEnd();
  map[norm.length] = text.length; // chốt cuối để tính điểm kết thúc match cuối cùng

  const maskRanges = [];
  for (const w of BANNED_WORDS) {
    const pattern = w.split(' ').join('\\s?');
    // Từ cấm chỉ 1 "cụm" (không có khoảng trắng, vd "dm","cc","cho") dễ khớp nhầm vào giữa từ vô hại khác
    // (vd "cc" nằm trong "school", "dm" nằm trong "admin") -> bắt buộc ranh giới từ ở 2 đầu.
    // Cụm từ cấm gồm NHIỀU từ (vd "vai ca lon") đã đủ đặc trưng, không cần ràng buộc này.
    const hasBoundary = !w.includes(' ');
    const re = new RegExp((hasBoundary ? '\\b' : '') + pattern + (hasBoundary ? '\\b' : ''), 'g');
    let m;
    while ((m = re.exec(norm))) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      const start = map[m.index], end = map[m.index + m[0].length];
      maskRanges.push([start, end]);
    }
  }
  if (maskRanges.length === 0) return text;
  maskRanges.sort((a, b) => a[0] - b[0]);
  let out = '', last = 0;
  for (const [s, e] of maskRanges) {
    if (s < last) continue; // bỏ qua vùng chồng lấn (đã bị che bởi match trước đó)
    out += text.slice(last, s) + '*'.repeat(e - s);
    last = e;
  }
  out += text.slice(last);
  return out;
}
// Kiểm tra nhanh 1 đoạn text có chứa từ cấm hay không (dùng cho nơi cần TỪ CHỐI thay vì che, ví dụ tên nhân vật) —
// so khớp trên bản đã chuẩn hoá đầy đủ nên chắc tay hơn moderateText, nhưng KHÔNG giữ được vị trí để che ký tự.
function containsBannedWord(text) {
  const norm = normalizeForFilter(text || '');
  return BANNED_WORDS.some((w) => norm.includes(w));
}
// Băm tên thành 1 mã "Ẩn danh#xxxx" ổn định (cùng người luôn ra cùng mã, để mod có thể đối chiếu nếu cần
// nhưng người chơi khác không biết đó là ai) — dùng hash đơn giản, đủ dùng cho mục đích hiển thị.
function anonTag(name) {
  let h = 0;
  const s = normName(name);
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
  return 'Ẩn danh#' + String(h % 10000).padStart(4, '0');
}
function dmKey(a, b) {
  const pair = [normName(a), normName(b)].sort();
  return 'dm:' + pair[0] + '|' + pair[1];
}

// Lấy IP thật của client qua Cloudflare (header do CF tự gắn, client không giả mạo được).
function getClientIp(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
}

// Danh sách tên phiên admin CỐ ĐỊNH — PHẢI đồng bộ với ADMIN_SESSION_NAMES bên index.html (client).
// Dùng để miễn nhiễm ban/kick server-side; client-side list chỉ quyết định hiện UI, không phải bảo mật
// thật (đó là việc của ADMIN_KEY) — nhưng cả 2 nơi cần khớp tên để tránh admin thật vẫn bị ban nhầm.
const ADMIN_SESSION_NAMES = ['toilalode', 'toilanoobmaxlv', 'toilanoobmaxlvv2', 'toilanoobyeunuoc', 'gokuta3004'];

// Admin (cố định trong danh sách trên, HOẶC được cấp quyền tạm thời qua /addplayer) được miễn nhiễm
// ban/kick — không ai (kể cả admin khác) có thể ban/kick nhầm hoặc cố ý một admin đang hoạt động.
async function isProtectedAdmin(env, name) {
  if (!name) return false;
  if (ADMIN_SESSION_NAMES.includes(name)) return true;
  const tempRaw = await env.GAME_DATA.get('tempadmin:' + name);
  return !!tempRaw;
}

// Ghi lại IP + deviceId gần nhất của 1 tên phiên — dùng để "banhwid" (ban theo cả tên + IP + thiết bị),
// vì tên phiên có thể đổi dễ dàng nhưng IP/deviceId khó đổi hơn.
async function recordPlayerMeta(env, name, request, deviceId) {
  const ip = getClientIp(request);
  const meta = { ip, deviceId: deviceId || null, updatedAt: Date.now() };
  await env.GAME_DATA.put('meta:' + name, JSON.stringify(meta));
}
// Kiểm tra tên/IP/deviceId có đang bị cấm hay không — trả về lý do cấm nếu có, null nếu không.
// Admin (cố định hoặc tạm thời) được MIỄN NHIỄM hoàn toàn với ban theo tên/IP/deviceId, kể cả khi có
// key ban "mồ côi" còn sót lại từ trước khi được cấp quyền admin.
async function checkBanned(env, name, request, deviceId) {
  if (name && await isProtectedAdmin(env, name)) return null;
  if (name && await env.GAME_DATA.get('banned:' + name)) return 'Tài khoản "' + name + '" đã bị cấm.';
  const ip = getClientIp(request);
  if (ip && ip !== 'unknown' && await env.GAME_DATA.get('banned-ip:' + ip)) return 'Thiết bị/IP này đã bị cấm.';
  if (deviceId && await env.GAME_DATA.get('banned-device:' + deviceId)) return 'Thiết bị này đã bị cấm.';
  return null;
}

/* ============================================================
   DURABLE OBJECT: GlobalState — 1 INSTANCE DUY NHẤT cho toàn server, quản lý:
   - Sự kiện toàn cục (x50, hidden — bật/tắt qua admin panel/lệnh admin)
   - Trade (gift trực tiếp + offer có xác nhận 2 chiều), atomic để tránh race condition
   Vì chỉ có 1 instance (luôn idFromName('singleton')), mọi thao tác ở đây tự nhiên là tuần tự/atomic —
   không cần lock thủ công, giải quyết đúng vấn đề "2 người trade cùng lúc" hay "admin bật sự kiện đúng lúc
   người khác đang đọc trạng thái".
   ============================================================ */
export class GlobalState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.events = null; // { x50: bool, hidden: bool } — load lười từ storage
    this.offers = null; // Map<offerId, offer> — load lười từ storage
  }
  async ensureLoaded() {
    if (this.events === null) {
      this.events = (await this.state.storage.get('events')) || { x50: false, hidden: false };
    }
    if (this.offers === null) {
      const stored = await this.state.storage.get('offers');
      this.offers = stored ? new Map(Object.entries(stored)) : new Map();
    }
  }
  async persistEvents() { await this.state.storage.put('events', this.events); }
  async persistOffers() { await this.state.storage.put('offers', Object.fromEntries(this.offers)); }

  async fetch(request) {
    await this.ensureLoaded();
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.endsWith('/event/status') && request.method === 'GET') {
      return json({ x50: !!this.events.x50, hidden: !!this.events.hidden });
    }

    if (path.endsWith('/event/set') && request.method === 'POST') {
      const body = await request.json();
      const event = body.event;
      if (event !== 'x50' && event !== 'hidden') return json({ error: 'Sự kiện không hợp lệ.' }, 400);
      this.events[event] = !!body.on;
      await this.persistEvents();
      return json({ ok: true, events: this.events });
    }

    // ---- Trade: gift trực tiếp (không cần xác nhận), server tự trừ/cộng dựa trên save data thật ----
    if (path.endsWith('/trade/gift') && request.method === 'POST') {
      const body = await request.json();
      const fromName = normName(body.fromName), toName = normName(body.toName);
      if (!fromName || !toName || fromName === toName) return json({ error: 'Tên người gửi/nhận không hợp lệ.' }, 400);
      try {
        const result = await this.applyItemTransfer(fromName, toName, body.items);
        return json({ ok: true, result });
      } catch (err) { return json({ error: err.message }, 400); }
    }

    // ---- Trade: tạo đề nghị trao đổi 2 chiều ----
    if (path.endsWith('/trade/offer/create') && request.method === 'POST') {
      const body = await request.json();
      const fromName = normName(body.fromName), toName = normName(body.toName);
      if (!fromName || !toName || fromName === toName) return json({ error: 'Tên người gửi/nhận không hợp lệ.' }, 400);
      const offerId = 'offer_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      const offer = {
        id: offerId, fromName, toName,
        fromItems: body.offerItems || {}, toItems: {},
        status: 'pending_to', // pending_to: chờ toName phản hồi | pending_from: đã counter, chờ fromName xác nhận
        createdAt: Date.now(),
      };
      this.offers.set(offerId, offer);
      await this.persistOffers();
      return json({ ok: true, offerId });
    }

    // ---- Trade: phản hồi đề nghị (chấp nhận / từ chối / counter-offer) ----
    if (path.endsWith('/trade/offer/respond') && request.method === 'POST') {
      const body = await request.json();
      const offer = this.offers.get(body.offerId);
      if (!offer) return json({ error: 'Đề nghị không tồn tại hoặc đã hết hạn.' }, 404);
      const name = normName(body.name);
      try {
        if (body.accept === false) {
          this.offers.delete(body.offerId);
          await this.persistOffers();
          return json({ ok: true, status: 'declined' });
        }
        if (offer.status === 'pending_to' && name === offer.toName) {
          if (body.counterItems) {
            offer.toItems = body.counterItems;
            offer.status = 'pending_from';
            this.offers.set(body.offerId, offer);
            await this.persistOffers();
            return json({ ok: true, status: 'countered' });
          }
          // Chấp nhận thẳng theo đề nghị ban đầu (toItems rỗng nghĩa là nhận không đổi lại gì)
          const result = await this.settleTrade(offer);
          this.offers.delete(body.offerId);
          await this.persistOffers();
          return json({ ok: true, status: 'completed', result });
        }
        if (offer.status === 'pending_from' && name === offer.fromName) {
          const result = await this.settleTrade(offer);
          this.offers.delete(body.offerId);
          await this.persistOffers();
          return json({ ok: true, status: 'completed', result });
        }
        return json({ error: 'Bạn không có quyền phản hồi đề nghị này ở trạng thái hiện tại.' }, 403);
      } catch (err) { return json({ error: err.message }, 400); }
    }

    // ---- Trade: danh sách đề nghị liên quan tới 1 người ----
    if (path.endsWith('/trade/offer/list') && request.method === 'GET') {
      const name = normName(url.searchParams.get('name'));
      const list = [...this.offers.values()].filter(o => o.fromName === name || o.toName === name);
      return json({ list });
    }

    return json({ error: 'Không tìm thấy endpoint trong GlobalState.' }, 404);
  }

  // Chuyển item 1 chiều từ fromName sang toName, validate item claimed có thật trong save của fromName.
  // items: { gold?: number, fruits?: string[], weapons?: string[], guns?: string[] }
  async applyItemTransfer(fromName, toName, items) {
    const fromRaw = await this.env.GAME_DATA.get('save:' + fromName);
    const toRaw = await this.env.GAME_DATA.get('save:' + toName);
    if (!fromRaw) throw new Error('Không tìm thấy dữ liệu người gửi.');
    if (!toRaw) throw new Error('Không tìm thấy dữ liệu người nhận (họ cần online/save ít nhất 1 lần).');
    const fromData = JSON.parse(fromRaw);
    const toData = JSON.parse(toRaw);
    removeItemsChecked(fromData, items); // ném lỗi nếu fromData không thật sự có đủ item claimed
    addItems(toData, items);
    await this.env.GAME_DATA.put('save:' + fromName, JSON.stringify(fromData));
    await this.env.GAME_DATA.put('save:' + toName, JSON.stringify(toData));
    return { fromName, toName, items };
  }

  // Hoán đổi 2 chiều khi cả 2 bên đã đồng ý (offer.fromItems đi từ from->to, offer.toItems đi từ to->from)
  async settleTrade(offer) {
    const fromRaw = await this.env.GAME_DATA.get('save:' + offer.fromName);
    const toRaw = await this.env.GAME_DATA.get('save:' + offer.toName);
    if (!fromRaw || !toRaw) throw new Error('Một trong hai bên không còn dữ liệu trên server.');
    const fromData = JSON.parse(fromRaw);
    const toData = JSON.parse(toRaw);
    // Validate CẢ HAI bên có đủ item trước khi đổi bất cứ gì (atomic all-or-nothing)
    removeItemsChecked(fromData, offer.fromItems, true);
    removeItemsChecked(toData, offer.toItems, true);
    removeItemsChecked(fromData, offer.fromItems);
    removeItemsChecked(toData, offer.toItems);
    addItems(toData, offer.fromItems);
    addItems(fromData, offer.toItems);
    await this.env.GAME_DATA.put('save:' + offer.fromName, JSON.stringify(fromData));
    await this.env.GAME_DATA.put('save:' + offer.toName, JSON.stringify(toData));
    return { fromName: offer.fromName, toName: offer.toName, fromItems: offer.fromItems, toItems: offer.toItems };
  }
}

// dryRun=true: chỉ kiểm tra đủ điều kiện, không trừ thật (dùng để validate trước khi trừ cả 2 bên trong settleTrade)
function removeItemsChecked(data, items, dryRun) {
  if (!items) return;
  if (items.gold) {
    const g = Number(items.gold) || 0;
    if ((data.gold || 0) < g) throw new Error('Không đủ Gold để giao dịch.');
    if (!dryRun) data.gold = (data.gold || 0) - g;
  }
  for (const field of ['fruits', 'weapons', 'guns']) {
    const want = items[field];
    if (!want || !want.length) continue;
    data[field] = Array.isArray(data[field]) ? data[field] : [];
    for (const it of want) {
      const idx = data[field].indexOf(it);
      if (idx === -1) throw new Error('Không sở hữu "' + it + '" trong ' + field + '.');
      if (!dryRun) data[field].splice(idx, 1);
    }
  }
}
function addItems(data, items) {
  if (!items) return;
  if (items.gold) data.gold = (data.gold || 0) + (Number(items.gold) || 0);
  for (const field of ['fruits', 'weapons', 'guns']) {
    if (!items[field] || !items[field].length) continue;
    data[field] = Array.isArray(data[field]) ? data[field] : [];
    data[field].push(...items[field]);
  }
}

/* ============================================================
   BÁN ITEM LẤY GOLD (server-authoritative) — áp dụng cho MỌI vật phẩm trade được (fruits/weapons/guns),
   dùng chung khái niệm "item" với hệ Trade sẵn có ở GlobalState. Vì Trade trước đây không có bảng giá cố
   định (chỉ chuyển ngang item theo thoả thuận 2 bên), bảng giá bán dưới đây là bảng giá MỚI, quy đổi trực
   tiếp ra Gold — không liên quan tới giá trị "công bằng" giữa 2 người chơi khi trade tay đôi.
   ============================================================ */
// Giá bán riêng theo TÊN CHÍNH XÁC (ưu tiên cao nhất) — dùng cho vật phẩm đặc biệt/hiếm.
const ITEM_SELL_PRICE_EXACT = {
  fruits: { 'Dragon': 30000, 'Kitsune': 26000, 'Empyrean Kitsune': 45000 },
  weapons: { 'Dark Blade': 80000 },
  guns: {},
};
// Giá bán MẶC ĐỊNH theo loại khi không khớp tên chính xác ở trên (vật phẩm thường/không xác định độ hiếm).
const ITEM_SELL_PRICE_DEFAULT = { fruits: 5000, weapons: 3000, guns: 3000 };
function sellPriceFor(field, itemName) {
  const exact = ITEM_SELL_PRICE_EXACT[field] && ITEM_SELL_PRICE_EXACT[field][itemName];
  if (exact != null) return exact;
  return ITEM_SELL_PRICE_DEFAULT[field] || 1000;
}

/* ============================================================
   DURABLE OBJECT: GuildState — instance DUY NHẤT toàn server, quản lý:
   1) Guild: tạo/giải tán/mời/kick/rời/đổi role, guild XP, bảng xếp hạng guild
   2) PvP có thưởng: báo cáo kết quả trận đấu (do client báo lên, vì combat chạy client-side),
      server cộng Gold + guild XP cho người thắng (thưởng lớn) và người thua (thưởng nhỏ an ủi),
      có cooldown chống spam báo cáo giả giữa cùng 1 cặp tên.
   3) Season Pass: XP theo mùa, 2 track thưởng (free/premium), admin cấu hình/reset mùa.
   4) Schedule sự kiện: admin đặt lịch tương lai để tự động bật/tắt sự kiện x50/hidden đúng giờ
      (thực thi bởi Cron Trigger gọi /schedule/check-due mỗi phút — xem export default { scheduled }).
   Cùng 1 instance singleton (idFromName('singleton')) để mọi thao tác tuần tự, tránh race condition
   khi nhiều người đổi guild/report PvP cùng lúc — giống cách GlobalState đang làm với event/trade.
   ============================================================ */
// Cấu hình Season Pass MẶC ĐỊNH khi chưa admin nào set — 10 tier, mỗi tier cần thêm 1000 XP (XP cộng dồn).
// Free track: Gold nhỏ giọt. Premium track (yêu cầu đã mua premium = admin cấp qua /season/grant-premium
// hoặc mua bằng Gold — xem endpoint /season/buy-premium): Gold nhiều hơn + vé Gacha.
function defaultSeason() {
  const tiers = [];
  for (let t = 1; t <= 10; t++) {
    tiers.push({
      tier: t,
      xpReq: t * 1000,
      freeReward: { gold: 2000 * t },
      premiumReward: { gold: 5000 * t, gachaTickets: t },
    });
  }
  return {
    seasonId: 'season1',
    name: 'Mùa 1',
    endsAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // mặc định 30 ngày kể từ lúc khởi tạo lần đầu
    premiumPriceGold: 50000,
    tiers,
  };
}

export class GuildState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.guilds = null;      // Map<guildIdLower, guild>  guild = {id,name,ownerName,members:[{name,role}],xp,createdAt}
    this.memberOf = null;    // Map<normName, guildIdLower> — tra cứu nhanh 1 người đang ở guild nào
    this.pvpCooldown = null; // Map<pairKey, ts> — chống báo cáo PvP lặp lại quá nhanh giữa 2 người
    this.season = null;      // { seasonId, name, endsAt, tiers:[{tier,xpReq,freeReward,premiumReward}] } — cấu hình mùa hiện tại (admin set)
    this.seasonProgress = null; // Map<normName, {xp, premium, claimedFree:[tier,...], claimedPremium:[tier,...]}>
    this.schedules = null;   // Map<scheduleId, {id,event,on,atTs,executed,createdBy}> — lịch tự động bật/tắt sự kiện toàn server
    // ---- Đấu Trường PvP (Đảo 4) — trạng thái NGẮN HẠN, chỉ giữ trong bộ nhớ (không cần persist qua
    // storage, vì 1 lượt thách đấu chỉ sống vài phút và DO tự giữ instance "singleton" xuyên suốt server
    // đang chạy — nếu DO bị evict giữa chừng, các trận dang dở mất đi là chấp nhận được, không phải dữ
    // liệu quan trọng cần bền vững như guild/save). ----
    this.arenaChallenges = new Map(); // challengeId -> { id, fromName, toName, createdAt, status:'pending'|'accepted'|'declined'|'expired' }
    this.arenaMatches = new Map();    // matchId -> { id, p1, p2, hp1, hp2, maxHp1, maxHp2, startedAt, status:'active'|'finished', winner, loser }
    this.arenaBusy = new Map();       // normName -> matchId  — chặn 1 người tham gia 2 trận cùng lúc
  }
  async ensureLoaded() {
    if (this.guilds === null) {
      const stored = await this.state.storage.get('guilds');
      this.guilds = stored ? new Map(Object.entries(stored)) : new Map();
    }
    if (this.memberOf === null) {
      const stored = await this.state.storage.get('memberOf');
      this.memberOf = stored ? new Map(Object.entries(stored)) : new Map();
    }
    if (this.pvpCooldown === null) {
      const stored = await this.state.storage.get('pvpCooldown');
      this.pvpCooldown = stored ? new Map(Object.entries(stored)) : new Map();
    }
    if (this.season === null) {
      this.season = (await this.state.storage.get('season')) || defaultSeason();
    }
    if (this.seasonProgress === null) {
      const stored = await this.state.storage.get('seasonProgress');
      this.seasonProgress = stored ? new Map(Object.entries(stored)) : new Map();
    }
    if (this.schedules === null) {
      const stored = await this.state.storage.get('schedules');
      this.schedules = stored ? new Map(Object.entries(stored)) : new Map();
    }
  }
  async persistGuilds() { await this.state.storage.put('guilds', Object.fromEntries(this.guilds)); }
  async persistMemberOf() { await this.state.storage.put('memberOf', Object.fromEntries(this.memberOf)); }
  async persistCooldown() {
    // Dọn bớt cooldown cũ (>10 phút) trước khi lưu, tránh Map phình vô hạn theo thời gian.
    const now = Date.now();
    for (const [k, ts] of this.pvpCooldown) { if (now - ts > 10 * 60 * 1000) this.pvpCooldown.delete(k); }
    await this.state.storage.put('pvpCooldown', Object.fromEntries(this.pvpCooldown));
  }
  async persistSeason() { await this.state.storage.put('season', this.season); }
  async persistSeasonProgress() { await this.state.storage.put('seasonProgress', Object.fromEntries(this.seasonProgress)); }
  async persistSchedules() { await this.state.storage.put('schedules', Object.fromEntries(this.schedules)); }
  getSeasonProgressFor(name) {
    if (!this.seasonProgress.has(name)) {
      this.seasonProgress.set(name, { xp: 0, premium: false, claimedFree: [], claimedPremium: [] });
    }
    return this.seasonProgress.get(name);
  }
  // Kết thúc 1 trận đấu trường: thưởng Gold thẳng vào save thật (thắng nhiều hơn thua đáng kể), cộng guild
  // XP cho guild của người thắng (tái dùng đúng cơ chế PvP report cũ), rồi giải phóng cả 2 khỏi arenaBusy.
  async finishArenaMatch(match, winner, loser) {
    match.status = 'finished';
    match.winner = winner;
    match.loser = loser;
    this.arenaBusy.delete(match.p1);
    this.arenaBusy.delete(match.p2);
    const WIN_GOLD = 800, LOSE_GOLD = 150, WIN_GUILD_XP = 25;
    let winnerData, loserData;
    try { winnerData = await loadSave(this.env, winner, winner); } catch (err) { winnerData = null; }
    try { loserData = await loadSave(this.env, loser, loser); } catch (err) { loserData = null; }
    if (winnerData) {
      winnerData.gold = (winnerData.gold || 0) + WIN_GOLD;
      await this.env.GAME_DATA.put('save:' + winner, JSON.stringify(winnerData));
    }
    if (loserData) {
      loserData.gold = (loserData.gold || 0) + LOSE_GOLD;
      await this.env.GAME_DATA.put('save:' + loser, JSON.stringify(loserData));
    }
    let guildAwarded = null;
    const winnerGuildId = this.memberOf.get(winner);
    if (winnerGuildId) {
      const guild = this.guilds.get(winnerGuildId);
      if (guild) {
        guild.xp = (guild.xp || 0) + WIN_GUILD_XP;
        await this.persistGuilds();
        guildAwarded = { guildName: guild.name, xpGained: WIN_GUILD_XP, totalXp: guild.xp };
      }
    }
    return {
      winner: { name: winner, goldGained: WIN_GOLD, gold: winnerData ? winnerData.gold : undefined },
      loser: { name: loser, goldGained: LOSE_GOLD, gold: loserData ? loserData.gold : undefined },
      guild: guildAwarded,
    };
  }

  async fetch(request) {
    await this.ensureLoaded();
    const url = new URL(request.url);
    const path = url.pathname;

    // ---- POST /guild/create  body: { ownerName, guildName } ----
    if (path.endsWith('/guild/create') && request.method === 'POST') {
      const body = await request.json();
      const ownerName = normName(body.ownerName);
      if (!ownerName) return json({ error: 'Thiếu tên người tạo.' }, 400);
      if (this.memberOf.has(ownerName)) return json({ error: 'Bạn đã ở trong 1 guild rồi, hãy rời guild cũ trước.' }, 400);
      const guildName = String(body.guildName || '').trim().slice(0, 30);
      if (!guildName) return json({ error: 'Thiếu tên guild.' }, 400);
      if (containsBannedWord(guildName)) return json({ error: 'Tên guild chứa từ ngữ không phù hợp.' }, 400);
      const guildId = guildName.toLowerCase();
      if (this.guilds.has(guildId)) return json({ error: 'Tên guild "' + guildName + '" đã tồn tại.' }, 400);
      const guild = {
        id: guildId, name: guildName, ownerName,
        members: [{ name: ownerName, role: 'leader' }],
        xp: 0, createdAt: Date.now(),
      };
      this.guilds.set(guildId, guild);
      this.memberOf.set(ownerName, guildId);
      await this.persistGuilds();
      await this.persistMemberOf();
      return json({ ok: true, guild });
    }

    // ---- POST /guild/disband  body: { name, guildId } — chỉ leader mới giải tán được ----
    if (path.endsWith('/guild/disband') && request.method === 'POST') {
      const body = await request.json();
      const name = normName(body.name);
      const guild = this.guilds.get(String(body.guildId || '').toLowerCase());
      if (!guild) return json({ error: 'Guild không tồn tại.' }, 404);
      if (guild.ownerName !== name) return json({ error: 'Chỉ leader mới được giải tán guild.' }, 403);
      for (const m of guild.members) this.memberOf.delete(m.name);
      this.guilds.delete(guild.id);
      await this.persistGuilds();
      await this.persistMemberOf();
      return json({ ok: true });
    }

    // ---- POST /guild/join  body: { name, guildId } — vào thẳng, không cần leader duyệt (đơn giản hoá) ----
    if (path.endsWith('/guild/join') && request.method === 'POST') {
      const body = await request.json();
      const name = normName(body.name);
      if (!name) return json({ error: 'Thiếu tên.' }, 400);
      if (this.memberOf.has(name)) return json({ error: 'Bạn đã ở trong 1 guild rồi.' }, 400);
      const guild = this.guilds.get(String(body.guildId || '').toLowerCase());
      if (!guild) return json({ error: 'Guild không tồn tại.' }, 404);
      if (guild.members.length >= 50) return json({ error: 'Guild đã đầy (tối đa 50 thành viên).' }, 400);
      guild.members.push({ name, role: 'member' });
      this.memberOf.set(name, guild.id);
      await this.persistGuilds();
      await this.persistMemberOf();
      return json({ ok: true, guild });
    }

    // ---- POST /guild/leave  body: { name } ----
    if (path.endsWith('/guild/leave') && request.method === 'POST') {
      const body = await request.json();
      const name = normName(body.name);
      const guildId = this.memberOf.get(name);
      if (!guildId) return json({ error: 'Bạn không ở trong guild nào.' }, 400);
      const guild = this.guilds.get(guildId);
      if (guild) {
        if (guild.ownerName === name) {
          // Leader rời -> giải tán luôn guild để tránh guild vô chủ (đơn giản hoá thay vì chuyển leader).
          for (const m of guild.members) this.memberOf.delete(m.name);
          this.guilds.delete(guildId);
        } else {
          guild.members = guild.members.filter(m => m.name !== name);
          this.memberOf.delete(name);
        }
      } else {
        this.memberOf.delete(name);
      }
      await this.persistGuilds();
      await this.persistMemberOf();
      return json({ ok: true });
    }

    // ---- POST /guild/kick  body: { name, targetName, guildId } — leader kick thành viên ----
    if (path.endsWith('/guild/kick') && request.method === 'POST') {
      const body = await request.json();
      const name = normName(body.name);
      const target = normName(body.targetName);
      const guild = this.guilds.get(String(body.guildId || '').toLowerCase());
      if (!guild) return json({ error: 'Guild không tồn tại.' }, 404);
      if (guild.ownerName !== name) return json({ error: 'Chỉ leader mới được kick thành viên.' }, 403);
      if (target === name) return json({ error: 'Không thể tự kick chính mình (dùng /guild/leave hoặc /guild/disband).' }, 400);
      const before = guild.members.length;
      guild.members = guild.members.filter(m => m.name !== target);
      if (guild.members.length === before) return json({ error: 'Người này không ở trong guild.' }, 400);
      this.memberOf.delete(target);
      await this.persistGuilds();
      await this.persistMemberOf();
      return json({ ok: true });
    }

    // ---- GET /guild/mine?name=xxx — guild hiện tại của 1 người (null nếu chưa có) ----
    if (path.endsWith('/guild/mine') && request.method === 'GET') {
      const name = normName(url.searchParams.get('name'));
      const guildId = this.memberOf.get(name);
      return json({ guild: guildId ? this.guilds.get(guildId) || null : null });
    }

    // ---- GET /guild/list — danh sách tất cả guild (để duyệt/tham gia) ----
    if (path.endsWith('/guild/list') && request.method === 'GET') {
      const list = [...this.guilds.values()].map(g => ({ id: g.id, name: g.name, ownerName: g.ownerName, memberCount: g.members.length, xp: g.xp }));
      return json({ list });
    }

    // ---- GET /guild/leaderboard?limit=20 — xếp hạng guild theo XP ----
    if (path.endsWith('/guild/leaderboard') && request.method === 'GET') {
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10)));
      const list = [...this.guilds.values()]
        .sort((a, b) => (b.xp || 0) - (a.xp || 0))
        .slice(0, limit)
        .map(g => ({ id: g.id, name: g.name, ownerName: g.ownerName, memberCount: g.members.length, xp: g.xp }));
      return json({ list });
    }

    // ---- POST /pvp/report  body: { winnerName, loserName } ----
    // Client báo cáo kết quả trận PvP sau khi combat kết thúc (combat chạy client-side, xem GameRoom action relay).
    // Server thưởng Gold trực tiếp vào save data thật trong KV (nguồn sự thật duy nhất) — bên thắng thưởng lớn,
    // bên thua thưởng an ủi nhỏ hơn hẳn — và cộng guild XP nếu người thắng có guild.
    // Chống spam/gian lận cơ bản: cooldown 60s giữa CÙNG 1 CẶP tên (theo cả 2 chiều thắng/thua).
    if (path.endsWith('/pvp/report') && request.method === 'POST') {
      const body = await request.json();
      const winnerName = normName(body.winnerName);
      const loserName = normName(body.loserName);
      if (!winnerName || !loserName || winnerName === loserName) {
        return json({ error: 'Tên người thắng/thua không hợp lệ.' }, 400);
      }
      const pairKey = [winnerName, loserName].sort().join('|');
      const now = Date.now();
      const lastTs = this.pvpCooldown.get(pairKey) || 0;
      const COOLDOWN_MS = 60 * 1000;
      if (now - lastTs < COOLDOWN_MS) {
        return json({ error: 'Cặp đấu này vừa được thưởng gần đây, thử lại sau ' + Math.ceil((COOLDOWN_MS - (now - lastTs)) / 1000) + 's.' }, 429);
      }
      const WIN_GOLD = 500, LOSE_GOLD = 100, WIN_GUILD_XP = 20;
      let winnerData, loserData;
      try {
        winnerData = await loadSave(this.env, winnerName, body.winnerName);
      } catch (err) { return json({ error: 'Không tìm thấy dữ liệu người thắng.' }, 400); }
      try {
        loserData = await loadSave(this.env, loserName, body.loserName);
      } catch (err) { return json({ error: 'Không tìm thấy dữ liệu người thua.' }, 400); }
      winnerData.gold = (winnerData.gold || 0) + WIN_GOLD;
      loserData.gold = (loserData.gold || 0) + LOSE_GOLD;
      await this.env.GAME_DATA.put('save:' + winnerName, JSON.stringify(winnerData));
      await this.env.GAME_DATA.put('save:' + loserName, JSON.stringify(loserData));
      // Cộng guild XP cho guild của người thắng (nếu có)
      let guildAwarded = null;
      const winnerGuildId = this.memberOf.get(winnerName);
      if (winnerGuildId) {
        const guild = this.guilds.get(winnerGuildId);
        if (guild) {
          guild.xp = (guild.xp || 0) + WIN_GUILD_XP;
          await this.persistGuilds();
          guildAwarded = { guildName: guild.name, xpGained: WIN_GUILD_XP, totalXp: guild.xp };
        }
      }
      this.pvpCooldown.set(pairKey, now);
      await this.persistCooldown();
      return json({
        ok: true,
        winner: { name: winnerName, goldGained: WIN_GOLD, gold: winnerData.gold },
        loser: { name: loserName, goldGained: LOSE_GOLD, gold: loserData.gold },
        guild: guildAwarded,
      });
    }

    // ======================== SEASON PASS ========================
    // ---- GET /season/status?name=xxx — cấu hình mùa hiện tại + tiến độ của 1 người (nếu có tên) ----
    if (path.endsWith('/season/status') && request.method === 'GET') {
      const name = normName(url.searchParams.get('name'));
      const progress = name ? this.getSeasonProgressFor(name) : { xp: 0, premium: false, claimedFree: [], claimedPremium: [] };
      if (name) { await this.persistSeasonProgress(); } // getSeasonProgressFor có thể vừa tạo entry mới -> lưu lại
      return json({ season: this.season, progress });
    }

    // ---- POST /season/add-xp  body: { name, xp } — cộng XP mùa (gọi khi hoàn thành nhiệm vụ/PvP/quest...) ----
    if (path.endsWith('/season/add-xp') && request.method === 'POST') {
      const body = await request.json();
      const name = normName(body.name);
      if (!name) return json({ error: 'Thiếu tên.' }, 400);
      const xpGain = Math.max(0, Math.floor(Number(body.xp) || 0));
      if (xpGain <= 0) return json({ error: 'Số XP không hợp lệ.' }, 400);
      const progress = this.getSeasonProgressFor(name);
      progress.xp += xpGain;
      await this.persistSeasonProgress();
      return json({ ok: true, progress });
    }

    // ---- POST /season/claim  body: { name, tier, track } — track: 'free' | 'premium' ----
    if (path.endsWith('/season/claim') && request.method === 'POST') {
      const body = await request.json();
      const name = normName(body.name);
      const tier = Number(body.tier);
      const track = body.track === 'premium' ? 'premium' : 'free';
      if (!name) return json({ error: 'Thiếu tên.' }, 400);
      const tierInfo = this.season.tiers.find(t => t.tier === tier);
      if (!tierInfo) return json({ error: 'Tier không hợp lệ.' }, 400);
      const progress = this.getSeasonProgressFor(name);
      if (progress.xp < tierInfo.xpReq) return json({ error: 'Chưa đủ XP mùa để nhận tier này (cần ' + tierInfo.xpReq + ', hiện có ' + progress.xp + ').' }, 400);
      if (track === 'premium' && !progress.premium) return json({ error: 'Chưa mua Premium Pass, không thể nhận thưởng Premium.' }, 403);
      const claimedList = track === 'premium' ? progress.claimedPremium : progress.claimedFree;
      if (claimedList.includes(tier)) return json({ error: 'Đã nhận thưởng tier này rồi.' }, 400);
      const reward = track === 'premium' ? tierInfo.premiumReward : tierInfo.freeReward;
      let data;
      try { data = await loadSave(this.env, name, body.name); } catch (err) { return json({ error: 'Không tìm thấy dữ liệu người chơi.' }, 400); }
      if (reward.gold) data.gold = (data.gold || 0) + reward.gold;
      if (reward.gachaTickets) data.gachaTickets = (data.gachaTickets || 0) + reward.gachaTickets;
      await this.env.GAME_DATA.put('save:' + name, JSON.stringify(data));
      claimedList.push(tier);
      await this.persistSeasonProgress();
      return json({ ok: true, reward, gold: data.gold, gachaTickets: data.gachaTickets });
    }

    // ---- POST /season/buy-premium  body: { name } — mua Premium Pass bằng Gold theo giá season.premiumPriceGold ----
    if (path.endsWith('/season/buy-premium') && request.method === 'POST') {
      const body = await request.json();
      const name = normName(body.name);
      if (!name) return json({ error: 'Thiếu tên.' }, 400);
      const progress = this.getSeasonProgressFor(name);
      if (progress.premium) return json({ error: 'Bạn đã có Premium Pass rồi.' }, 400);
      const price = this.season.premiumPriceGold || 0;
      let data;
      try { data = await loadSave(this.env, name, body.name); } catch (err) { return json({ error: 'Không tìm thấy dữ liệu người chơi.' }, 400); }
      if ((data.gold || 0) < price) return json({ error: 'Không đủ Gold để mua Premium Pass (cần ' + price + ').' }, 400);
      data.gold -= price;
      await this.env.GAME_DATA.put('save:' + name, JSON.stringify(data));
      progress.premium = true;
      await this.persistSeasonProgress();
      return json({ ok: true, gold: data.gold });
    }

    // ---- POST /season/admin/configure  body: { key, name?, endsAt?, premiumPriceGold?, tiers? } — admin chỉnh cấu hình mùa ----
    if (path.endsWith('/season/admin/configure') && request.method === 'POST') {
      const body = await request.json();
      if (!checkAdminKey(this.env, body.key)) return json({ error: 'Sai admin key.' }, 403);
      if (body.name) this.season.name = String(body.name).trim().slice(0, 60);
      if (body.endsAt) this.season.endsAt = Number(body.endsAt) || this.season.endsAt;
      if (body.premiumPriceGold != null) this.season.premiumPriceGold = Math.max(0, Number(body.premiumPriceGold) || 0);
      if (Array.isArray(body.tiers)) this.season.tiers = body.tiers;
      await this.persistSeason();
      return json({ ok: true, season: this.season });
    }

    // ---- POST /season/admin/reset  body: { key, seasonId?, name? } — admin bắt đầu mùa MỚI, xoá sạch tiến độ cũ ----
    if (path.endsWith('/season/admin/reset') && request.method === 'POST') {
      const body = await request.json();
      if (!checkAdminKey(this.env, body.key)) return json({ error: 'Sai admin key.' }, 403);
      this.season = defaultSeason();
      if (body.seasonId) this.season.seasonId = String(body.seasonId).trim().slice(0, 40);
      if (body.name) this.season.name = String(body.name).trim().slice(0, 60);
      this.seasonProgress = new Map();
      await this.persistSeason();
      await this.persistSeasonProgress();
      return json({ ok: true, season: this.season });
    }

    // ======================== SCHEDULE SỰ KIỆN (x50 / hidden) ========================
    // ---- POST /schedule/create  body: { key, event:'x50'|'hidden', on:bool, atTs } — admin đặt lịch tự động bật/tắt ----
    if (path.endsWith('/schedule/create') && request.method === 'POST') {
      const body = await request.json();
      if (!checkAdminKey(this.env, body.key)) return json({ error: 'Sai admin key.' }, 403);
      const event = body.event;
      if (event !== 'x50' && event !== 'hidden') return json({ error: 'Sự kiện không hợp lệ.' }, 400);
      const atTs = Number(body.atTs);
      if (!atTs || atTs <= Date.now()) return json({ error: 'Thời điểm lên lịch phải ở tương lai.' }, 400);
      const id = 'sch_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      const schedule = { id, event, on: !!body.on, atTs, executed: false, createdAt: Date.now() };
      this.schedules.set(id, schedule);
      await this.persistSchedules();
      return json({ ok: true, schedule });
    }

    // ---- GET /schedule/list?key=xxx — admin xem toàn bộ lịch (kể cả đã chạy xong) ----
    if (path.endsWith('/schedule/list') && request.method === 'GET') {
      if (!checkAdminKey(this.env, url.searchParams.get('key'))) return json({ error: 'Sai admin key.' }, 403);
      const list = [...this.schedules.values()].sort((a, b) => a.atTs - b.atTs);
      return json({ list });
    }

    // ---- POST /schedule/cancel  body: { key, scheduleId } — admin huỷ 1 lịch CHƯA chạy ----
    if (path.endsWith('/schedule/cancel') && request.method === 'POST') {
      const body = await request.json();
      if (!checkAdminKey(this.env, body.key)) return json({ error: 'Sai admin key.' }, 403);
      const sch = this.schedules.get(body.scheduleId);
      if (!sch) return json({ error: 'Lịch không tồn tại.' }, 404);
      if (sch.executed) return json({ error: 'Lịch này đã chạy xong, không thể huỷ.' }, 400);
      this.schedules.delete(body.scheduleId);
      await this.persistSchedules();
      return json({ ok: true });
    }

    // ---- GET /schedule/check-due  (internal, gọi bởi Cron Trigger mỗi phút) ----
    // Quét mọi lịch chưa chạy đã tới hoặc quá thời điểm atTs -> áp dụng lên GlobalState.events + đánh dấu executed.
    if (path.endsWith('/schedule/check-due') && request.method === 'POST') {
      const now = Date.now();
      const due = [...this.schedules.values()].filter(s => !s.executed && s.atTs <= now);
      const applied = [];
      for (const sch of due) {
        const stub = getGlobalStub(this.env);
        await stub.fetch(new Request('https://internal/event/set', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: sch.event, on: sch.on }),
        }));
        sch.executed = true;
        applied.push(sch);
      }
      if (applied.length) await this.persistSchedules();
      return json({ ok: true, applied });
    }

    // ======================== ĐẤU TRƯỜNG PVP (ĐẢO 4) ========================
    // ---- POST /arena/challenge  body: { fromName, toName } — gửi lời thách đấu ----
    if (path.endsWith('/arena/challenge') && request.method === 'POST') {
      const body = await request.json();
      const fromName = normName(body.fromName);
      const toName = normName(body.toName);
      if (!fromName || !toName) return json({ error: 'Thiếu tên.' }, 400);
      if (fromName === toName) return json({ error: 'Không thể tự thách đấu chính mình.' }, 400);
      if (this.arenaBusy.has(fromName)) return json({ error: 'Bạn đang trong 1 trận đấu khác.' }, 400);
      if (this.arenaBusy.has(toName)) return json({ error: 'Đối thủ đang trong 1 trận đấu khác.' }, 400);
      // Dọn lời thách cũ (nếu có) giữa đúng cặp này trước khi tạo lời mới, tránh chồng chất rác.
      for (const [id, c] of this.arenaChallenges) {
        if (c.status === 'pending' && ((c.fromName === fromName && c.toName === toName) || (c.fromName === toName && c.toName === fromName))) {
          this.arenaChallenges.delete(id);
        }
      }
      const id = 'chal_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      const challenge = { id, fromName, toName, createdAt: Date.now(), status: 'pending' };
      this.arenaChallenges.set(id, challenge);
      return json({ ok: true, challenge });
    }

    // ---- GET /arena/challenges?name=xxx — lời thách đấu ĐANG CHỜ liên quan tới `name` (gửi đi hoặc nhận được) ----
    if (path.endsWith('/arena/challenges') && request.method === 'GET') {
      const name = normName(url.searchParams.get('name'));
      const now = Date.now();
      // Lời thách quá 60s không phản hồi coi như hết hạn — dọn luôn khi liệt kê.
      for (const [id, c] of this.arenaChallenges) {
        if (c.status === 'pending' && now - c.createdAt > 60000) c.status = 'expired';
        if (c.status !== 'pending' && now - c.createdAt > 120000) this.arenaChallenges.delete(id);
      }
      const list = [...this.arenaChallenges.values()].filter(c => c.fromName === name || c.toName === name);
      return json({ list });
    }

    // ---- POST /arena/respond  body: { challengeId, name, accept } ----
    if (path.endsWith('/arena/respond') && request.method === 'POST') {
      const body = await request.json();
      const name = normName(body.name);
      const challenge = this.arenaChallenges.get(body.challengeId);
      if (!challenge) return json({ error: 'Lời thách đấu không tồn tại hoặc đã hết hạn.' }, 404);
      if (challenge.toName !== name) return json({ error: 'Lời thách đấu này không dành cho bạn.' }, 403);
      if (challenge.status !== 'pending') return json({ error: 'Lời thách đấu đã được xử lý.' }, 400);
      if (!body.accept) {
        challenge.status = 'declined';
        return json({ ok: true, accepted: false });
      }
      if (this.arenaBusy.has(challenge.fromName) || this.arenaBusy.has(challenge.toName)) {
        challenge.status = 'expired';
        return json({ error: 'Một trong hai người đã vào trận khác trước đó.' }, 400);
      }
      // Lấy maxHp thật của cả 2 người từ save data (server-authoritative), KHÔNG tin số client gửi lên,
      // để đảm bảo "stat cân bằng" đúng nghĩa dựa trên chỉ số THẬT đã đầu tư, không thể giả mạo.
      let data1, data2;
      try { data1 = await loadSave(this.env, challenge.fromName, challenge.fromName); } catch (err) { return json({ error: 'Không tìm thấy dữ liệu người thách đấu.' }, 400); }
      try { data2 = await loadSave(this.env, challenge.toName, challenge.toName); } catch (err) { return json({ error: 'Không tìm thấy dữ liệu người được thách.' }, 400); }
      const maxHp1 = Math.max(1, Number(data1.maxHp) || 1000);
      const maxHp2 = Math.max(1, Number(data2.maxHp) || 1000);
      const matchId = 'match_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      const match = {
        id: matchId, p1: challenge.fromName, p2: challenge.toName,
        hp1: maxHp1, hp2: maxHp2, maxHp1, maxHp2,
        startedAt: Date.now(), status: 'active', winner: null, loser: null,
      };
      this.arenaMatches.set(matchId, match);
      this.arenaBusy.set(challenge.fromName, matchId);
      this.arenaBusy.set(challenge.toName, matchId);
      challenge.status = 'accepted';
      challenge.matchId = matchId;
      return json({ ok: true, accepted: true, match });
    }

    // ---- GET /arena/match?name=xxx — trận đấu trường ĐANG DIỄN RA của `name` (null nếu không có) ----
    if (path.endsWith('/arena/match') && request.method === 'GET') {
      const name = normName(url.searchParams.get('name'));
      const matchId = this.arenaBusy.get(name);
      const match = matchId ? this.arenaMatches.get(matchId) : null;
      return json({ match: match && match.status === 'active' ? match : null });
    }

    // ---- POST /arena/hit  body: { matchId, attackerName, damage } ----
    // Đòn đánh THẬT trong trận đấu trường: server trừ HP người bị đánh (không phải người gửi request tự
    // trừ HP mình — chặn được kiểu gian lận "tôi tự báo tôi bị đánh 1 sát thương" để giả trận). Chỉ 2
    // người trong đúng match mới gọi được, damage được validate không vượt quá 1 ngưỡng hợp lý/lần.
    if (path.endsWith('/arena/hit') && request.method === 'POST') {
      const body = await request.json();
      const attackerName = normName(body.attackerName);
      const match = this.arenaMatches.get(body.matchId);
      if (!match || match.status !== 'active') return json({ error: 'Trận đấu không tồn tại hoặc đã kết thúc.' }, 404);
      if (attackerName !== match.p1 && attackerName !== match.p2) return json({ error: 'Bạn không thuộc trận đấu này.' }, 403);
      const dmg = Math.max(0, Math.min(1e7, Number(body.damage) || 0)); // chặn damage vô lý/lần gọi
      if (dmg <= 0) return json({ error: 'Damage không hợp lệ.' }, 400);
      const isAttackerP1 = attackerName === match.p1;
      if (isAttackerP1) match.hp2 = Math.max(0, match.hp2 - dmg);
      else match.hp1 = Math.max(0, match.hp1 - dmg);
      // Người bị đánh về 0 HP -> kết thúc trận NGAY tại đây (server tự phát hiện, không cần ai báo cáo tay).
      if (match.hp1 <= 0 || match.hp2 <= 0) {
        const winner = match.hp1 <= 0 ? match.p2 : match.p1;
        const loser = match.hp1 <= 0 ? match.p1 : match.p2;
        const reward = await this.finishArenaMatch(match, winner, loser);
        return json({ ok: true, hp1: match.hp1, hp2: match.hp2, finished: true, winner, loser, reward });
      }
      return json({ ok: true, hp1: match.hp1, hp2: match.hp2, finished: false });
    }

    // ---- POST /arena/forfeit  body: { matchId, name } — đầu hàng/thoát trận giữa chừng (tính thua) ----
    if (path.endsWith('/arena/forfeit') && request.method === 'POST') {
      const body = await request.json();
      const name = normName(body.name);
      const match = this.arenaMatches.get(body.matchId);
      if (!match || match.status !== 'active') return json({ error: 'Trận đấu không tồn tại hoặc đã kết thúc.' }, 404);
      if (name !== match.p1 && name !== match.p2) return json({ error: 'Bạn không thuộc trận đấu này.' }, 403);
      const winner = name === match.p1 ? match.p2 : match.p1;
      const reward = await this.finishArenaMatch(match, winner, name);
      return json({ ok: true, winner, loser: name, reward });
    }

    return json({ error: 'Không tìm thấy endpoint trong GuildState.' }, 404);
  }
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

    // POST /broadcast-system -> admin gửi thông báo hệ thống tới toàn phòng (gọi nội bộ từ worker chính)
    if (url.pathname.endsWith('/broadcast-system') && request.method === 'POST') {
      const body = await request.json();
      this.broadcast({ t: 'system', text: String(body.text || '').slice(0, 300) }, null);
      return json({ ok: true });
    }

    // POST /kick-name -> admin kick 1 người chơi theo tên, ngắt WebSocket của họ ngay lập tức (gọi nội bộ)
    if (url.pathname.endsWith('/kick-name') && request.method === 'POST') {
      const body = await request.json();
      const target = normName(body.name);
      let kicked = 0;
      for (const [ws, info] of this.sessions) {
        if (normName(info.name) === target) {
          this.safeSend(ws, { t: 'kicked', text: body.reason || 'Bạn đã bị admin kick khỏi phòng chung.' });
          try { ws.close(1000, 'kicked'); } catch (err) {}
          this.sessions.delete(ws);
          kicked++;
        }
      }
      if (kicked > 0) this.broadcast({ t: 'system', text: '👢 "' + (body.name || target) + '" đã bị kick khỏi phòng.' }, null);
      return json({ ok: true, kicked });
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
          const mode = msg.mode === 'unmoderated' || msg.mode === 'anonymous' ? msg.mode : 'moderated';
          const outText = mode === 'moderated' ? moderateText(text) : text;
          const outName = mode === 'anonymous' ? anonTag(name) : name;
          this.broadcast({ t: 'chat', id: mode === 'anonymous' ? null : id, name: outName, text: outText, mode }, null);
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
  // unlockedAchievements: chỉ nhận mảng string id, giới hạn số lượng để tránh spam field khổng lồ.
  if (data.unlockedAchievements !== undefined) {
    if (!Array.isArray(data.unlockedAchievements) || data.unlockedAchievements.length > 500 ||
        !data.unlockedAchievements.every(x => typeof x === 'string' && x.length <= 60)) {
      throw new Error('Trường "unlockedAchievements" sai định dạng.');
    }
  }
  if (data.activeTitle !== undefined && data.activeTitle !== null && typeof data.activeTitle !== 'string') {
    throw new Error('Trường "activeTitle" sai kiểu dữ liệu.');
  }
  // dailyQuests/weeklyQuests: object nhỏ gọn { resetAt, progress:{id:num}, claimed:[id,...] } — validate lỏng, chỉ chặn kiểu sai.
  for (const qk of ['dailyQuestState', 'weeklyQuestState']) {
    if (data[qk] !== undefined && (typeof data[qk] !== 'object' || data[qk] === null || Array.isArray(data[qk]))) {
      throw new Error('Trường "' + qk + '" sai định dạng.');
    }
  }
}

// Trả về Durable Object stub DUY NHẤT cho toàn server (dùng idFromName cố định) — điểm truy cập chung
// cho sự kiện + trade, đảm bảo mọi request đều đi qua đúng 1 instance để tránh race condition.
function getGlobalStub(env) {
  const id = env.GLOBAL.idFromName('singleton');
  return env.GLOBAL.get(id);
}
// Cùng kiểu singleton stub như getGlobalStub, nhưng cho Durable Object GuildState (guild + PvP thưởng).
function getGuildStub(env) {
  const id = env.GUILD.idFromName('singleton');
  return env.GUILD.get(id);
}
// Xác thực admin: so khớp trực tiếp với secret ADMIN_KEY trên server — KHÔNG dựa vào tên phiên client,
// vì tên phiên có thể bị giả mạo dễ dàng. Đây là lớp bảo vệ thật cho admin panel + admin command.
function checkAdminKey(env, key) {
  return !!env.ADMIN_KEY && typeof key === 'string' && key === env.ADMIN_KEY;
}

// Các lệnh admin TẠM THỜI (cấp qua /addplayer) ĐƯỢC PHÉP dùng — không gồm ban/banHwid/unban/cấp-thu hồi
// quyền admin của người khác, để tránh admin tạm thời tự leo thang quyền hoặc ban bừa người khác.
const TEMP_ADMIN_ALLOWED_CMDS = new Set([
  'setLevel', 'setStat', 'setMoney', 'setFightingStyle', 'setFruit', 'tpIsland',
  'setCamera', 'setHp', 'setMana', 'setGachaTickets', 'addFruitBag', 'addFruitTemp', 'kick', 'unkick', 'addEvent',
]);

async function loadSave(env, name, label) {
  const raw = await env.GAME_DATA.get('save:' + name);
  if (!raw) throw new Error('Không tìm thấy người chơi "' + label + '".');
  return JSON.parse(raw);
}

// ---- LOG LỊCH SỬ LỆNH ADMIN ----
// Ghi lại mọi lệnh admin THÀNH CÔNG (ai dùng, dùng lệnh gì, args gì, khi nào, admin thật hay admin tạm thời)
// vào 1 danh sách chung trong KV, giữ tối đa ADMIN_LOG_MAX bản ghi gần nhất (giống ring buffer đơn giản).
// Hữu ích để đối chiếu khi có nhiều tài khoản admin cùng thao tác — biết ai đã làm gì, lúc nào.
const ADMIN_LOG_KEY = 'adminlog:list';
const ADMIN_LOG_MAX = 500;
async function appendAdminLog(env, entry) {
  try {
    const raw = await env.GAME_DATA.get(ADMIN_LOG_KEY);
    const list = raw ? JSON.parse(raw) : [];
    list.push(entry);
    while (list.length > ADMIN_LOG_MAX) list.shift();
    await env.GAME_DATA.put(ADMIN_LOG_KEY, JSON.stringify(list));
  } catch (err) { /* log lỗi không được làm hỏng lệnh admin chính, chỉ bỏ qua */ }
}

// Thực thi 1 lệnh admin cụ thể, thao tác trực tiếp lên save data trong KV (nguồn sự thật duy nhất).
async function runAdminCommand(env, cmd, args) {
  const name = normName(args.name);
  switch (cmd) {
    // ---- /setlv tên level ----
    case 'setLevel': {
      if (!name) throw new Error('Thiếu tên người chơi.');
      const data = await loadSave(env, name, args.name);
      data.level = Math.min(9999, Math.max(1, Number(args.level) || 1));
      await env.GAME_DATA.put('save:' + name, JSON.stringify(data));
      return { name, level: data.level };
    }
    // ---- /setstat tên tên_chỉ_số giá_trị ----  (vd: str, agi, hp, mana, atk... tuỳ field lưu trong save)
    case 'setStat': {
      if (!name) throw new Error('Thiếu tên người chơi.');
      const stat = (args.stat || '').trim();
      if (!stat) throw new Error('Thiếu tên chỉ số.');
      const data = await loadSave(env, name, args.name);
      data.stats = data.stats && typeof data.stats === 'object' ? data.stats : {};
      data.stats[stat] = Number(args.value) || 0;
      await env.GAME_DATA.put('save:' + name, JSON.stringify(data));
      return { name, stat, value: data.stats[stat] };
    }
    // ---- /setmoney tên số_tiền ----
    case 'setMoney': {
      if (!name) throw new Error('Thiếu tên người chơi.');
      const data = await loadSave(env, name, args.name);
      data.gold = Math.max(0, Number(args.amount) || 0);
      await env.GAME_DATA.put('save:' + name, JSON.stringify(data));
      return { name, gold: data.gold };
    }
    // ---- /setfightingstyle tên tên_võ ----
    case 'setFightingStyle': {
      if (!name) throw new Error('Thiếu tên người chơi.');
      const style = (args.style || '').trim();
      if (!style) throw new Error('Thiếu tên võ.');
      const data = await loadSave(env, name, args.name);
      data.fightingStyle = style;
      await env.GAME_DATA.put('save:' + name, JSON.stringify(data));
      return { name, fightingStyle: style };
    }
    // ---- /setfruit tên tên_trái ----  (đặt thẳng trái ác quỷ đang ăn, khác với addFruitBag/addFruitTemp)
    case 'setFruit': {
      if (!name) throw new Error('Thiếu tên người chơi.');
      const fruit = (args.fruit || '').trim();
      if (!fruit) throw new Error('Thiếu tên trái ác quỷ.');
      const data = await loadSave(env, name, args.name);
      data.fruit = fruit;
      await env.GAME_DATA.put('save:' + name, JSON.stringify(data));
      return { name, fruit };
    }
    // ---- /tpisland tên tên_đảo ----
    case 'tpIsland': {
      if (!name) throw new Error('Thiếu tên người chơi.');
      const island = (args.island || '').trim();
      if (!island) throw new Error('Thiếu tên đảo.');
      const data = await loadSave(env, name, args.name);
      data.currentIsland = island;
      data.pendingTeleport = island; // client đọc field này khi load để tự dịch chuyển tới đảo
      await env.GAME_DATA.put('save:' + name, JSON.stringify(data));
      return { name, island };
    }
    // ---- /setcamera tên giá_trị ----
    case 'setCamera': {
      if (!name) throw new Error('Thiếu tên người chơi.');
      const data = await loadSave(env, name, args.name);
      data.cameraZoom = Number(args.value) || 1;
      await env.GAME_DATA.put('save:' + name, JSON.stringify(data));
      return { name, cameraZoom: data.cameraZoom };
    }
    // ---- /sethp tên giá_trị ----
    case 'setHp': {
      if (!name) throw new Error('Thiếu tên người chơi.');
      const data = await loadSave(env, name, args.name);
      data.hp = Math.max(0, Number(args.value) || 0);
      if (data.maxHp) data.hp = Math.min(data.hp, data.maxHp * 100); // chặn giá trị quá vô lý
      await env.GAME_DATA.put('save:' + name, JSON.stringify(data));
      return { name, hp: data.hp };
    }
    // ---- /setmana tên giá_trị ----
    case 'setMana': {
      if (!name) throw new Error('Thiếu tên người chơi.');
      const data = await loadSave(env, name, args.name);
      data.mana = Math.max(0, Number(args.value) || 0);
      await env.GAME_DATA.put('save:' + name, JSON.stringify(data));
      return { name, mana: data.mana };
    }
    // ---- /setgacha tên số_vé ----  (đặt thẳng số lượt quay Gacha miễn phí — field "gachaTickets")
    case 'setGachaTickets': {
      if (!name) throw new Error('Thiếu tên người chơi.');
      const data = await loadSave(env, name, args.name);
      data.gachaTickets = Math.max(0, Math.floor(Number(args.amount) || 0));
      await env.GAME_DATA.put('save:' + name, JSON.stringify(data));
      return { name, gachaTickets: data.gachaTickets };
    }
    // ---- /addfruitbag tên tên_trái ----  (thêm vào rương/túi đồ LƯU TRỮ — field "fruitStorage")
    case 'addFruitBag': {
      if (!name) throw new Error('Thiếu tên người chơi.');
      const fruit = (args.fruit || '').trim();
      if (!fruit) throw new Error('Thiếu tên trái ác quỷ.');
      const data = await loadSave(env, name, args.name);
      data.fruitStorage = Array.isArray(data.fruitStorage) ? data.fruitStorage : [];
      data.fruitStorage.push(fruit);
      await env.GAME_DATA.put('save:' + name, JSON.stringify(data));
      return { name, fruitStorage: fruit };
    }
    // ---- /addfruittemp tên tên_trái ----  (thêm vào túi đồ TẠM THỜI — field "fruitTemp", mất khi hết phiên)
    case 'addFruitTemp': {
      if (!name) throw new Error('Thiếu tên người chơi.');
      const fruit = (args.fruit || '').trim();
      if (!fruit) throw new Error('Thiếu tên trái ác quỷ.');
      const data = await loadSave(env, name, args.name);
      data.fruitTemp = Array.isArray(data.fruitTemp) ? data.fruitTemp : [];
      data.fruitTemp.push(fruit);
      await env.GAME_DATA.put('save:' + name, JSON.stringify(data));
      return { name, fruitTemp: fruit };
    }
    // ---- /ban tên ----  (chỉ khoá theo TÊN — chỉ admin thật mới được dùng)
    case 'ban': {
      if (!name) throw new Error('Thiếu tên người chơi.');
      if (await isProtectedAdmin(env, name)) throw new Error('Không thể ban admin ("' + name + '" được kháng ban).');
      await env.GAME_DATA.put('banned:' + name, JSON.stringify({ bannedAt: Date.now() }));
      return { name, banned: true };
    }
    // ---- /banhwid tên ----  (khoá theo TÊN + IP + deviceId gần nhất — chỉ admin thật mới được dùng)
    case 'banHwid': {
      if (!name) throw new Error('Thiếu tên người chơi.');
      if (await isProtectedAdmin(env, name)) throw new Error('Không thể ban admin ("' + name + '" được kháng ban).');
      await env.GAME_DATA.put('banned:' + name, JSON.stringify({ bannedAt: Date.now() }));
      const metaRaw = await env.GAME_DATA.get('meta:' + name);
      let ip = null, deviceId = null;
      if (metaRaw) {
        const meta = JSON.parse(metaRaw);
        ip = meta.ip; deviceId = meta.deviceId;
        if (ip && ip !== 'unknown') await env.GAME_DATA.put('banned-ip:' + ip, JSON.stringify({ bannedAt: Date.now(), fromName: name }));
        if (deviceId) await env.GAME_DATA.put('banned-device:' + deviceId, JSON.stringify({ bannedAt: Date.now(), fromName: name }));
      }
      return { name, banned: true, ip: ip || null, deviceId: deviceId || null };
    }
    // ---- /unban tên ----  (gỡ cấm tên + IP + deviceId đã ghi nhận gần nhất — chỉ admin thật mới được dùng)
    case 'unban': {
      if (!name) throw new Error('Thiếu tên người chơi.');
      await env.GAME_DATA.delete('banned:' + name);
      const metaRaw = await env.GAME_DATA.get('meta:' + name);
      if (metaRaw) {
        const meta = JSON.parse(metaRaw);
        if (meta.ip && meta.ip !== 'unknown') await env.GAME_DATA.delete('banned-ip:' + meta.ip);
        if (meta.deviceId) await env.GAME_DATA.delete('banned-device:' + meta.deviceId);
      }
      return { name, banned: false };
    }
    // ---- /checkBan tên ----  (CHẨN ĐOÁN: cho biết CHÍNH XÁC tên/IP/deviceId nào đang bị khoá,
    // khác với /unban vốn chỉ xoá theo meta hiện tại — dùng khi unban theo tên không đủ để gỡ hẳn) ----
    case 'checkBan': {
      if (!name) throw new Error('Thiếu tên người chơi.');
      const metaRaw = await env.GAME_DATA.get('meta:' + name);
      const meta = metaRaw ? JSON.parse(metaRaw) : null;
      const [nameBanned, ipBanned, deviceBanned] = await Promise.all([
        env.GAME_DATA.get('banned:' + name),
        meta && meta.ip && meta.ip !== 'unknown' ? env.GAME_DATA.get('banned-ip:' + meta.ip) : Promise.resolve(null),
        meta && meta.deviceId ? env.GAME_DATA.get('banned-device:' + meta.deviceId) : Promise.resolve(null),
      ]);
      return {
        name,
        lastIp: meta ? meta.ip : null,
        lastDeviceId: meta ? meta.deviceId : null,
        bannedByName: !!nameBanned,
        bannedByIp: !!ipBanned,
        bannedByDevice: !!deviceBanned,
      };
    }
    // ---- /unbanIp ip / /unbanDevice deviceId ----  (gỡ THẲNG theo IP hoặc deviceId cụ thể, không phụ
    // thuộc meta của bất kỳ tên nào — dùng để dọn các khoá "mồ côi" còn sót lại từ lần banHwid trước) ----
    case 'unbanIp': {
      const ip = (args.ip || '').trim();
      if (!ip) throw new Error('Thiếu IP.');
      await env.GAME_DATA.delete('banned-ip:' + ip);
      return { ip, banned: false };
    }
    case 'unbanDevice': {
      const deviceId = (args.deviceId || '').trim();
      if (!deviceId) throw new Error('Thiếu deviceId.');
      await env.GAME_DATA.delete('banned-device:' + deviceId);
      return { deviceId, banned: false };
    }
    // ---- /kick tên ----  (ngắt kết nối ngay + chặn vào lại phòng chung trong 5 phút) ----
    case 'kick': {
      if (!name) throw new Error('Thiếu tên người chơi.');
      if (await isProtectedAdmin(env, name)) throw new Error('Không thể kick admin ("' + name + '" được kháng kick).');
      await env.GAME_DATA.put('kicked:' + name, JSON.stringify({ kickedAt: Date.now() }), { expirationTtl: 300 });
      const id = env.ROOM.idFromName('world1');
      const stub = env.ROOM.get(id);
      const res = await stub.fetch(new Request('https://internal/kick-name', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      }));
      const j = await res.json().catch(() => ({}));
      return { name, kicked: true, disconnected: j.kicked || 0 };
    }
    // ---- /unkick tên ----  (gỡ chặn vào lại phòng chung ngay lập tức) ----
    case 'unkick': {
      if (!name) throw new Error('Thiếu tên người chơi.');
      await env.GAME_DATA.delete('kicked:' + name);
      return { name, kicked: false };
    }
    // ---- /addplayer tên ----  (cấp quyền admin TẠM THỜI — panel + 1 tập lệnh giới hạn — chỉ admin thật mới được dùng)
    case 'addTempAdmin': {
      if (!name) throw new Error('Thiếu tên người chơi.');
      await env.GAME_DATA.put('tempadmin:' + name, JSON.stringify({ grantedAt: Date.now() }));
      return { name, tempAdmin: true };
    }
    // ---- /removeplayer tên ----  (thu hồi quyền admin tạm thời — chỉ admin thật mới được dùng) ----
    case 'removeTempAdmin': {
      if (!name) throw new Error('Thiếu tên người chơi.');
      await env.GAME_DATA.delete('tempadmin:' + name);
      return { name, tempAdmin: false };
    }
    // ---- /addevent x50 | /addevent hidden | /addevent x50 off | /addevent hidden off ----
    case 'addEvent': {
      const type = (args.type || '').trim().toLowerCase();
      if (type !== 'x50' && type !== 'hidden') throw new Error('Loại sự kiện không hợp lệ (chỉ nhận "x50" hoặc "hidden").');
      // on mặc định true (giữ hành vi cũ khi không truyền) — cho phép tắt bằng args.on === false.
      const on = args.on === false ? false : true;
      const stub = getGlobalStub(env);
      await stub.fetch(new Request('https://internal/event/set', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: type, on }),
      }));
      return { event: type, on };
    }
    case 'broadcast': {
      const text = (args.text || '').trim();
      if (!text) throw new Error('Thiếu nội dung thông báo.');
      const id = env.ROOM.idFromName('world1');
      const stub = env.ROOM.get(id);
      await stub.fetch(new Request('https://internal/broadcast-system', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      }));
      return { broadcasted: true, text };
    }
    // ---- /giveall gold=<số> fruit=<tên> ----  (cấp Gold và/hoặc 1 trái ác quỷ vào rương LƯU TRỮ cho
    // TOÀN BỘ người chơi đã từng save trên server — kể cả đang offline, họ sẽ thấy khi load lại sau).
    // Quét bằng KV list({prefix:'save:'}) giống /admin/players/all, không cần biết ai đang online.
    case 'giveAll': {
      const goldAmount = Math.max(0, Math.floor(Number(args.gold) || 0));
      const fruit = (args.fruit || '').trim();
      const weapon = (args.weapon || '').trim();
      const gun = (args.gun || '').trim();
      if (!goldAmount && !fruit && !weapon && !gun) throw new Error('Cần ít nhất 1 trong: gold / fruit / weapon / gun.');
      let cursor;
      let count = 0;
      do {
        const page = await env.GAME_DATA.list({ prefix: 'save:', cursor, limit: 1000 });
        for (const k of page.keys) {
          const raw = await env.GAME_DATA.get(k.name);
          if (!raw) continue;
          let data;
          try { data = JSON.parse(raw); } catch (e) { continue; }
          if (goldAmount) data.gold = (data.gold || 0) + goldAmount;
          if (fruit) { data.fruitStorage = Array.isArray(data.fruitStorage) ? data.fruitStorage : []; data.fruitStorage.push(fruit); }
          if (weapon) { data.weapons = Array.isArray(data.weapons) ? data.weapons : []; data.weapons.push(weapon); }
          if (gun) { data.guns = Array.isArray(data.guns) ? data.guns : []; data.guns.push(gun); }
          await env.GAME_DATA.put(k.name, JSON.stringify(data));
          count++;
        }
        cursor = page.cursor;
        if (page.list_complete) break;
      } while (cursor);
      return { giveAll: true, gold: goldAmount || undefined, fruit: fruit || undefined, weapon: weapon || undefined, gun: gun || undefined, playersAffected: count };
    }
    // ---- /deleteaccount tên ----  (XOÁ VĨNH VIỄN tài khoản: save + tên đã đăng ký + entry leaderboard.
    // Tên sẽ được THẢ RA cho người khác đăng ký lại. KHÔNG xoá lịch sử ban/kick (giữ lại để chặn né ban
    // bằng cách tự xoá tài khoản rồi đăng ký lại tên khác — ban theo IP/device vẫn còn hiệu lực).
    // Dùng cho: (1) người chơi tự xoá phiên của MÌNH (client gọi qua cmd này với chính tên họ),
    // (2) admin xoá tài khoản người khác. Chặn xoá nhầm tài khoản admin thật.)
    case 'deleteAccount': {
      if (!name) throw new Error('Thiếu tên tài khoản cần xoá.');
      if (await isProtectedAdmin(env, name)) throw new Error('Không thể xoá tài khoản admin.');
      await Promise.all([
        env.GAME_DATA.delete('save:' + name),
        env.GAME_DATA.delete('name:' + name),
        env.GAME_DATA.delete('lb:' + name),
        // Đặt cờ "kicked" TTL 5 phút để nếu người này đang online, họ không rejoin được phòng chung ngay
        // sau khi bị xoá (chặn tại điểm kết nối WebSocket mới — xem check ở /room/:id/ws bên dưới).
        env.GAME_DATA.put('kicked:' + name, JSON.stringify({ kickedAt: Date.now(), reason: 'Tài khoản đã bị admin xoá.' }), { expirationTtl: 300 }),
      ]);
      return { deleted: true, name };
    }
    default:
      throw new Error('Lệnh admin không tồn tại: ' + cmd);
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

      // ---- GET /my-status?name=xxx (public) — tự tra trạng thái ban/kick của CHÍNH tên đó, không lộ
      // thông tin người khác. Dùng để hiện lý do rõ ràng khi vào phòng chung thất bại thay vì chỉ thấy
      // mã lỗi WebSocket khó hiểu (1006) không kèm nội dung. ----
      if (path === '/my-status' && request.method === 'GET') {
        const name = normName(url.searchParams.get('name'));
        const deviceId = url.searchParams.get('deviceId') || null;
        const ip = getClientIp(request);
        if (!name) return json({ banned: false, kicked: false });
        if (await isProtectedAdmin(env, name)) return json({ banned: false, kicked: false, reason: null });
        const [bannedRaw, kickedRaw, ipBannedRaw, deviceBannedRaw] = await Promise.all([
          env.GAME_DATA.get('banned:' + name),
          env.GAME_DATA.get('kicked:' + name),
          ip && ip !== 'unknown' ? env.GAME_DATA.get('banned-ip:' + ip) : Promise.resolve(null),
          deviceId ? env.GAME_DATA.get('banned-device:' + deviceId) : Promise.resolve(null),
        ]);
        // Trả thêm lý do CHI TIẾT + chính IP/deviceId hiện tại của bạn, để phân biệt "bị ban theo tên" với
        // "bị ban treo theo IP/thiết bị" (trường hợp gây nhầm lẫn nhất — tên chưa từng bị /ban nhưng vẫn
        // không vào được phòng chung vì IP/deviceId cũ từng dính banHwid ở tên khác).
        const banned = !!bannedRaw || !!ipBannedRaw || !!deviceBannedRaw;
        let reason = null;
        if (bannedRaw) reason = 'name';
        else if (ipBannedRaw) reason = 'ip';
        else if (deviceBannedRaw) reason = 'device';
        return json({ banned, kicked: !!kickedRaw, reason, yourIp: ip, yourDeviceId: deviceId });
      }

      // ---- POST /register-name  body: { name, deviceId } ----
      if (path === '/register-name' && request.method === 'POST') {
        const body = await request.json();
        const rawName = (body.name || '').trim();
        const name = normName(rawName);
        if (!name) return json({ error: 'Tên không hợp lệ' }, 400);
        const banReason = await checkBanned(env, name, request, body.deviceId);
        if (banReason) return json({ ok: false, error: banReason }, 403);
        const existing = await env.GAME_DATA.get('name:' + name);
        if (existing) return json({ ok: false, error: 'Tên này đã có người dùng.' }, 409);
        await env.GAME_DATA.put('name:' + name, JSON.stringify({ registeredAt: Date.now() }));
        await recordPlayerMeta(env, name, request, body.deviceId);
        return json({ ok: true });
      }

      // ---- POST /account/delete-self  body: { name } ----  (KHÔNG cần admin key — người chơi tự xoá
      // TÀI KHOẢN CỦA CHÍNH MÌNH khi bấm "Xoá Dữ Liệu/Chơi Lại Từ Đầu": xoá save + tên đăng ký + leaderboard
      // trên SERVER, tên được thả ra cho người khác dùng lại. Không cần xác thực gì thêm ngoài đúng format
      // tên, vì hành động này chỉ tự huỷ dữ liệu của chính tên gửi lên — không ảnh hưởng người khác. ----
      if (path === '/account/delete-self' && request.method === 'POST') {
        const body = await request.json();
        const name = normName(body.name);
        if (!name) return json({ error: 'Thiếu tên tài khoản.' }, 400);
        if (await isProtectedAdmin(env, name)) return json({ error: 'Không thể xoá tài khoản admin.' }, 403);
        await Promise.all([
          env.GAME_DATA.delete('save:' + name),
          env.GAME_DATA.delete('name:' + name),
          env.GAME_DATA.delete('lb:' + name),
        ]);
        return json({ ok: true, deleted: name });
      }

      // ---- POST /save  body: { name, data, deviceId } ----
      // Đây là ĐIỂM DUY NHẤT ghi số liệu save vào server — validate range/kiểu dữ liệu ngay tại đây để
      // chặn số liệu bất thường (level/gold vượt giới hạn game...) được lưu vào KV, dù client có bị sửa thế nào.
      if (path === '/save' && request.method === 'POST') {
        const body = await request.json();
        const name = normName(body.name);
        if (!name) return json({ error: 'Thiếu tên phiên' }, 400);
        const banReason = await checkBanned(env, name, request, body.deviceId);
        if (banReason) return json({ error: banReason }, 403);
        const data = body.data || {};
        try { validateSaveDataBasic(data); } catch (err) { return json({ error: 'Dữ liệu save bất thường, bị từ chối: ' + err.message }, 400); }
        await env.GAME_DATA.put('save:' + name, JSON.stringify(data));
        await recordPlayerMeta(env, name, request, body.deviceId);
        return json({ ok: true, savedAt: Date.now() });
      }

      // ---- GET /load?name=xxx ----
      if (path === '/load' && request.method === 'GET') {
        const name = normName(url.searchParams.get('name'));
        if (!name) return json({ error: 'Thiếu tham số name' }, 400);
        const raw = await env.GAME_DATA.get('save:' + name);
        return json({ data: raw ? JSON.parse(raw) : null });
      }

      // ---- POST /leaderboard/submit  body: { name, level, gold, bossKillCount, anonymous } ----
      if (path === '/leaderboard/submit' && request.method === 'POST') {
        const body = await request.json();
        const name = normName(body.name);
        if (!name) return json({ error: 'Thiếu tên' }, 400);
        const anonymous = !!body.anonymous;
        const entry = {
          name: (body.name || '').trim(),
          displayName: anonymous ? anonTag(body.name) : (body.name || '').trim(),
          anonymous,
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
        // Chỉ trả displayName ra ngoài (đã che tên thật nếu anonymous) — không lộ `name` thật khi ẩn danh.
        const publicList = entries.slice(0, limit).map(e => ({
          displayName: e.displayName || e.name,
          anonymous: !!e.anonymous,
          level: e.level, gold: e.gold, bossKillCount: e.bossKillCount, updatedAt: e.updatedAt,
        }));
        return json({ list: publicList });
      }

      // ---- ROOM: /room/:roomId/ws  và  /room/:roomId/count -> route sang Durable Object ----
      const roomMatch = path.match(/^\/room\/([a-zA-Z0-9_-]+)\/(ws|count)$/);
      if (roomMatch) {
        const roomId = roomMatch[1];
        if (roomMatch[2] === 'ws') {
          const wsName = normName(url.searchParams.get('name'));
          const banReason = await checkBanned(env, wsName, request, url.searchParams.get('deviceId'));
          if (banReason) return json({ error: banReason }, 403);
          if (wsName && !(await isProtectedAdmin(env, wsName)) && await env.GAME_DATA.get('kicked:' + wsName)) {
            return json({ error: 'Bạn vừa bị kick khỏi phòng chung, thử lại sau ít phút.' }, 403);
          }
        }
        const id = env.ROOM.idFromName(roomId);
        const stub = env.ROOM.get(id);
        return stub.fetch(request);
      }

      // ---- GET /admin/is-temp?name=xxx (public) — client dùng để tự hiện Admin Panel cho admin tạm thời ----
      if (path === '/admin/is-temp' && request.method === 'GET') {
        const name = normName(url.searchParams.get('name'));
        if (!name) return json({ tempAdmin: false });
        const raw = await env.GAME_DATA.get('tempadmin:' + name);
        return json({ tempAdmin: !!raw });
      }

      // ---- GET /trade/inventory?name=xxx (public) — dùng để 2 bên xem túi đồ thật của nhau trước khi trade ----
      if (path === '/trade/inventory' && request.method === 'GET') {
        const name = normName(url.searchParams.get('name'));
        if (!name) return json({ error: 'Thiếu tham số name.' }, 400);
        const raw = await env.GAME_DATA.get('save:' + name);
        if (!raw) return json({ error: 'Không tìm thấy dữ liệu người chơi "' + name + '".' }, 404);
        const data = JSON.parse(raw);
        return json({
          name,
          level: data.level || 1,
          gold: data.gold || 0,
          fruits: Array.isArray(data.fruits) ? data.fruits : [],
          weapons: Array.isArray(data.weapons) ? data.weapons : [],
          guns: Array.isArray(data.guns) ? data.guns : [],
        });
      }

      // ======================== ADMIN ========================
      // ---- POST /admin/verify  body: { key } ----
      if (path === '/admin/verify' && request.method === 'POST') {
        const body = await request.json();
        return json({ ok: checkAdminKey(env, body.key) });
      }

      // ---- POST /admin/command  body: { key, actingName, cmd, args } ----
      // Xác thực: HOẶC key đúng ADMIN_KEY thật (admin thật, dùng được MỌI lệnh), HOẶC actingName là 1
      // người chơi đang được cấp "admin tạm thời" (qua /addplayer) — khi đó chỉ được dùng tập lệnh an toàn
      // trong TEMP_ADMIN_ALLOWED_CMDS (không được ban/banhwid/unban/addplayer/removeplayer).
      // Các lệnh admin (cmd): setLevel, setStat, setMoney, setFightingStyle, setFruit, tpIsland, setCamera,
      //   setHp, setMana, setGachaTickets, ban, banHwid, unban, kick, unkick, addFruitBag, addFruitTemp,
      //   addTempAdmin, removeTempAdmin, addEvent, broadcast — xem chi tiết args trong runAdminCommand() bên trên.
      if (path === '/admin/command' && request.method === 'POST') {
        const body = await request.json();
        const { cmd, args = {} } = body;
        const isRealAdmin = checkAdminKey(env, body.key);
        let isTempAdmin = false;
        if (!isRealAdmin) {
          const actingName = normName(body.actingName);
          if (actingName) isTempAdmin = !!(await env.GAME_DATA.get('tempadmin:' + actingName));
        }
        if (!isRealAdmin && !isTempAdmin) return json({ error: 'Sai admin key hoặc bạn không có quyền admin.' }, 403);
        if (isTempAdmin && !isRealAdmin && !TEMP_ADMIN_ALLOWED_CMDS.has(cmd)) {
          return json({ error: 'Lệnh "' + cmd + '" chỉ admin thật (có Admin Key) mới được dùng.' }, 403);
        }
        try {
          const result = await runAdminCommand(env, cmd, args);
          // Ghi log SAU KHI lệnh chạy thành công — không log lệnh bị từ chối/lỗi để tránh rác vô nghĩa.
          const actingName = normName(body.actingName) || '(admin key trực tiếp)';
          appendAdminLog(env, {
            ts: Date.now(),
            by: actingName,
            byType: isRealAdmin ? 'admin_that' : 'admin_tam_thoi',
            cmd, args, result,
          }); // fire-and-forget, không chặn phản hồi cho người dùng
          return json({ ok: true, result });
        } catch (err) { return json({ error: err.message }, 400); }
      }

      // ---- GET /admin/players/all?key=xxx  (chỉ admin thật) ----
      // Liệt kê MỌI người chơi đã từng lưu game (kể cả chưa từng nộp leaderboard, kể cả đang offline),
      // kèm level/gold hiện tại + trạng thái ban/kick — dùng cho bảng quản trị. KHÔNG trả IP/deviceId.
      if (path === '/admin/players/all' && request.method === 'GET') {
        if (!checkAdminKey(env, url.searchParams.get('key'))) return json({ error: 'Sai admin key.' }, 403);
        let cursor;
        const players = [];
        do {
          const page = await env.GAME_DATA.list({ prefix: 'save:', cursor, limit: 1000 });
          for (const k of page.keys) {
            const nname = k.name.slice('save:'.length);
            const raw = await env.GAME_DATA.get(k.name);
            let level = 1, gold = 0, displayName = nname;
            if (raw) {
              try {
                const sv = JSON.parse(raw);
                level = Number(sv.level) || 1;
                gold = Number(sv.gold) || 0;
                if (sv.displayName) displayName = sv.displayName;
              } catch (e) {}
            }
            const [bannedRaw, kickedRaw, isAdmin] = await Promise.all([
              env.GAME_DATA.get('banned:' + nname),
              env.GAME_DATA.get('kicked:' + nname),
              isProtectedAdmin(env, nname),
            ]);
            players.push({
              name: nname,
              displayName,
              level, gold,
              banned: !!bannedRaw,
              kicked: !!kickedRaw,
              isAdmin,
            });
          }
          cursor = page.cursor;
          if (page.list_complete) break;
        } while (cursor);
        players.sort((a, b) => a.name.localeCompare(b.name));
        return json({ list: players });
      }

      // ---- GET /admin/log?key=xxx&limit=100 ----  (chỉ admin thật mới xem được lịch sử lệnh)
      if (path === '/admin/log' && request.method === 'GET') {
        if (!checkAdminKey(env, url.searchParams.get('key'))) return json({ error: 'Sai admin key.' }, 403);
        const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10)));
        const raw = await env.GAME_DATA.get(ADMIN_LOG_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return json({ list: list.slice(-limit).reverse() }); // mới nhất lên đầu
      }

      // ---- POST /admin/event/set  body: { key, event, on } ----
      if (path === '/admin/event/set' && request.method === 'POST') {
        const body = await request.json();
        if (!checkAdminKey(env, body.key)) return json({ error: 'Sai admin key.' }, 403);
        const stub = getGlobalStub(env);
        const fwd = new Request('https://internal/event/set', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: body.event, on: body.on }),
        });
        return stub.fetch(fwd);
      }

      // ---- GET /event/status (public) ----
      if (path === '/event/status' && request.method === 'GET') {
        const stub = getGlobalStub(env);
        return stub.fetch(new Request('https://internal/event/status'));
      }

      // ======================== TRADE ========================
      if (path === '/trade/gift' && request.method === 'POST') {
        const stub = getGlobalStub(env);
        return stub.fetch(new Request('https://internal/trade/gift', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await request.text() }));
      }
      if (path === '/trade/offer/create' && request.method === 'POST') {
        const stub = getGlobalStub(env);
        return stub.fetch(new Request('https://internal/trade/offer/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await request.text() }));
      }
      if (path === '/trade/offer/respond' && request.method === 'POST') {
        const stub = getGlobalStub(env);
        return stub.fetch(new Request('https://internal/trade/offer/respond', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await request.text() }));
      }
      if (path === '/trade/offer/list' && request.method === 'GET') {
        const stub = getGlobalStub(env);
        return stub.fetch(new Request('https://internal/trade/offer/list?name=' + encodeURIComponent(url.searchParams.get('name') || '')));
      }

      // ======================== CHAT: DM (1-1) & GROUP ========================
      // ---- POST /chat/dm/send  body: { fromName, toName, text, mode } ----
      if (path === '/chat/dm/send' && request.method === 'POST') {
        const body = await request.json();
        const fromName = (body.fromName || '').trim(), toName = normName(body.toName);
        if (!fromName.trim() || !toName) return json({ error: 'Thiếu tên người gửi/nhận.' }, 400);
        const mode = body.mode === 'unmoderated' || body.mode === 'anonymous' ? body.mode : 'moderated';
        let text = String(body.text || '').slice(0, 500);
        if (!text) return json({ error: 'Tin nhắn trống.' }, 400);
        if (mode === 'moderated') text = moderateText(text);
        const displayName = mode === 'anonymous' ? anonTag(fromName) : fromName;
        const key = dmKey(fromName, toName);
        const raw = await env.GAME_DATA.get(key);
        const history = raw ? JSON.parse(raw) : [];
        history.push({ from: displayName, realFrom: normName(fromName), text, mode, ts: Date.now() });
        while (history.length > 200) history.shift(); // giữ tối đa 200 tin gần nhất mỗi cặp
        await env.GAME_DATA.put(key, JSON.stringify(history));
        return json({ ok: true });
      }

      // ---- GET /chat/dm/history?a=NAME&b=NAME&limit=50 ----
      if (path === '/chat/dm/history' && request.method === 'GET') {
        const a = url.searchParams.get('a'), b = url.searchParams.get('b');
        if (!a || !b) return json({ error: 'Thiếu tham số a/b.' }, 400);
        const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10)));
        const raw = await env.GAME_DATA.get(dmKey(a, b));
        const history = raw ? JSON.parse(raw) : [];
        return json({ list: history.slice(-limit) });
      }

      // ---- POST /chat/group/create  body: { ownerName, groupName, members: [name,...] } ----
      if (path === '/chat/group/create' && request.method === 'POST') {
        const body = await request.json();
        const ownerName = normName(body.ownerName);
        if (!ownerName) return json({ error: 'Thiếu ownerName.' }, 400);
        const members = Array.from(new Set([ownerName, ...(Array.isArray(body.members) ? body.members.map(normName) : [])]));
        const groupId = 'grp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
        const group = { id: groupId, name: (body.groupName || 'Nhóm').trim().slice(0, 40), owner: ownerName, members, createdAt: Date.now() };
        await env.GAME_DATA.put('group:' + groupId, JSON.stringify(group));
        for (const m of members) {
          const listRaw = await env.GAME_DATA.get('groups-of:' + m);
          const list = listRaw ? JSON.parse(listRaw) : [];
          list.push(groupId);
          await env.GAME_DATA.put('groups-of:' + m, JSON.stringify(list));
        }
        return json({ ok: true, groupId });
      }

      // ---- POST /chat/group/send  body: { groupId, fromName, text, mode } ----
      if (path === '/chat/group/send' && request.method === 'POST') {
        const body = await request.json();
        const groupRaw = await env.GAME_DATA.get('group:' + body.groupId);
        if (!groupRaw) return json({ error: 'Nhóm không tồn tại.' }, 404);
        const group = JSON.parse(groupRaw);
        const fromName = (body.fromName || '').trim();
        if (!group.members.includes(normName(fromName))) return json({ error: 'Bạn không phải thành viên nhóm này.' }, 403);
        const mode = body.mode === 'unmoderated' || body.mode === 'anonymous' ? body.mode : 'moderated';
        let text = String(body.text || '').slice(0, 500);
        if (!text) return json({ error: 'Tin nhắn trống.' }, 400);
        if (mode === 'moderated') text = moderateText(text);
        const displayName = mode === 'anonymous' ? anonTag(fromName) : fromName;
        const histKey = 'group-chat:' + body.groupId;
        const raw = await env.GAME_DATA.get(histKey);
        const history = raw ? JSON.parse(raw) : [];
        history.push({ from: displayName, realFrom: normName(fromName), text, mode, ts: Date.now() });
        while (history.length > 300) history.shift();
        await env.GAME_DATA.put(histKey, JSON.stringify(history));
        return json({ ok: true });
      }

      // ---- GET /chat/group/history?groupId=xxx&limit=50 ----
      if (path === '/chat/group/history' && request.method === 'GET') {
        const groupId = url.searchParams.get('groupId');
        if (!groupId) return json({ error: 'Thiếu groupId.' }, 400);
        const limit = Math.min(300, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10)));
        const raw = await env.GAME_DATA.get('group-chat:' + groupId);
        const history = raw ? JSON.parse(raw) : [];
        return json({ list: history.slice(-limit) });
      }

      // ---- GET /chat/group/list?name=xxx ----
      if (path === '/chat/group/list' && request.method === 'GET') {
        const name = normName(url.searchParams.get('name'));
        if (!name) return json({ error: 'Thiếu tham số name.' }, 400);
        const listRaw = await env.GAME_DATA.get('groups-of:' + name);
        const groupIds = listRaw ? JSON.parse(listRaw) : [];
        const groups = [];
        for (const gid of groupIds) {
          const raw = await env.GAME_DATA.get('group:' + gid);
          if (raw) groups.push(JSON.parse(raw));
        }
        return json({ list: groups });
      }

      // ======================== GUILD ========================
      if (path === '/guild/create' && request.method === 'POST') {
        const stub = getGuildStub(env);
        return stub.fetch(new Request('https://internal/guild/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await request.text() }));
      }
      if (path === '/guild/disband' && request.method === 'POST') {
        const stub = getGuildStub(env);
        return stub.fetch(new Request('https://internal/guild/disband', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await request.text() }));
      }
      if (path === '/guild/join' && request.method === 'POST') {
        const stub = getGuildStub(env);
        return stub.fetch(new Request('https://internal/guild/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await request.text() }));
      }
      if (path === '/guild/leave' && request.method === 'POST') {
        const stub = getGuildStub(env);
        return stub.fetch(new Request('https://internal/guild/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await request.text() }));
      }
      if (path === '/guild/kick' && request.method === 'POST') {
        const stub = getGuildStub(env);
        return stub.fetch(new Request('https://internal/guild/kick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await request.text() }));
      }
      if (path === '/guild/mine' && request.method === 'GET') {
        const stub = getGuildStub(env);
        return stub.fetch(new Request('https://internal/guild/mine?name=' + encodeURIComponent(url.searchParams.get('name') || '')));
      }
      if (path === '/guild/list' && request.method === 'GET') {
        const stub = getGuildStub(env);
        return stub.fetch(new Request('https://internal/guild/list'));
      }
      if (path === '/guild/leaderboard' && request.method === 'GET') {
        const stub = getGuildStub(env);
        return stub.fetch(new Request('https://internal/guild/leaderboard?limit=' + encodeURIComponent(url.searchParams.get('limit') || '20')));
      }

      // ======================== PVP CÓ THƯỞNG ========================
      if (path === '/pvp/report' && request.method === 'POST') {
        const stub = getGuildStub(env);
        return stub.fetch(new Request('https://internal/pvp/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await request.text() }));
      }

      // ======================== SEASON PASS ========================
      if (path === '/season/status' && request.method === 'GET') {
        const stub = getGuildStub(env);
        return stub.fetch(new Request('https://internal/season/status?name=' + encodeURIComponent(url.searchParams.get('name') || '')));
      }
      if (path === '/season/add-xp' && request.method === 'POST') {
        const stub = getGuildStub(env);
        return stub.fetch(new Request('https://internal/season/add-xp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await request.text() }));
      }
      if (path === '/season/claim' && request.method === 'POST') {
        const stub = getGuildStub(env);
        return stub.fetch(new Request('https://internal/season/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await request.text() }));
      }
      if (path === '/season/buy-premium' && request.method === 'POST') {
        const stub = getGuildStub(env);
        return stub.fetch(new Request('https://internal/season/buy-premium', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await request.text() }));
      }
      if (path === '/season/admin/configure' && request.method === 'POST') {
        const stub = getGuildStub(env);
        return stub.fetch(new Request('https://internal/season/admin/configure', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await request.text() }));
      }
      if (path === '/season/admin/reset' && request.method === 'POST') {
        const stub = getGuildStub(env);
        return stub.fetch(new Request('https://internal/season/admin/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await request.text() }));
      }

      // ======================== ĐẤU TRƯỜNG PVP (ĐẢO 4) ========================
      if (path === '/arena/challenge' && request.method === 'POST') {
        const stub = getGuildStub(env);
        return stub.fetch(new Request('https://internal/arena/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await request.text() }));
      }
      if (path === '/arena/challenges' && request.method === 'GET') {
        const stub = getGuildStub(env);
        return stub.fetch(new Request('https://internal/arena/challenges?name=' + encodeURIComponent(url.searchParams.get('name') || '')));
      }
      if (path === '/arena/respond' && request.method === 'POST') {
        const stub = getGuildStub(env);
        return stub.fetch(new Request('https://internal/arena/respond', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await request.text() }));
      }
      if (path === '/arena/match' && request.method === 'GET') {
        const stub = getGuildStub(env);
        return stub.fetch(new Request('https://internal/arena/match?name=' + encodeURIComponent(url.searchParams.get('name') || '')));
      }
      if (path === '/arena/hit' && request.method === 'POST') {
        const stub = getGuildStub(env);
        return stub.fetch(new Request('https://internal/arena/hit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await request.text() }));
      }
      if (path === '/arena/forfeit' && request.method === 'POST') {
        const stub = getGuildStub(env);
        return stub.fetch(new Request('https://internal/arena/forfeit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await request.text() }));
      }

      // ======================== SCHEDULE SỰ KIỆN ========================
      if (path === '/schedule/create' && request.method === 'POST') {
        const stub = getGuildStub(env);
        return stub.fetch(new Request('https://internal/schedule/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await request.text() }));
      }
      if (path === '/schedule/list' && request.method === 'GET') {
        const stub = getGuildStub(env);
        return stub.fetch(new Request('https://internal/schedule/list?key=' + encodeURIComponent(url.searchParams.get('key') || '')));
      }
      if (path === '/schedule/cancel' && request.method === 'POST') {
        const stub = getGuildStub(env);
        return stub.fetch(new Request('https://internal/schedule/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await request.text() }));
      }

      // ======================== BÁN ITEM LẤY GOLD ========================
      // ---- POST /item/sell  body: { name, field:'fruits'|'weapons'|'guns', item:'Tên chính xác' } ----
      // Validate item CÓ THẬT trong save trước khi trừ (giống removeItemsChecked), rồi cộng Gold theo bảng giá.
      if (path === '/item/sell' && request.method === 'POST') {
        const body = await request.json();
        const name = normName(body.name);
        const field = body.field;
        const itemName = String(body.item || '').trim();
        if (!name) return json({ error: 'Thiếu tên người chơi.' }, 400);
        if (!['fruits', 'weapons', 'guns'].includes(field)) return json({ error: 'Loại vật phẩm không hợp lệ.' }, 400);
        if (!itemName) return json({ error: 'Thiếu tên vật phẩm muốn bán.' }, 400);
        let data;
        try { data = await loadSave(env, name, body.name); } catch (err) { return json({ error: 'Không tìm thấy dữ liệu người chơi.' }, 400); }
        data[field] = Array.isArray(data[field]) ? data[field] : [];
        const idx = data[field].indexOf(itemName);
        if (idx === -1) return json({ error: 'Bạn không sở hữu "' + itemName + '" trong ' + field + '.' }, 400);
        const price = sellPriceFor(field, itemName);
        data[field].splice(idx, 1);
        data.gold = (data.gold || 0) + price;
        await env.GAME_DATA.put('save:' + name, JSON.stringify(data));
        return json({ ok: true, sold: itemName, field, price, gold: data.gold });
      }
      // ---- GET /item/sell-prices — bảng giá công khai để client hiển thị trước khi bán ----
      if (path === '/item/sell-prices' && request.method === 'GET') {
        return json({ exact: ITEM_SELL_PRICE_EXACT, default: ITEM_SELL_PRICE_DEFAULT });
      }

      return json({ error: 'Không tìm thấy endpoint: ' + path }, 404);
    } catch (err) {
      return json({ error: 'Lỗi server: ' + err.message }, 500);
    }
  },

  // ---- Cron Trigger (cấu hình trong wrangler.toml: [triggers] crons = ["* * * * *"]) ----
  // Chạy mỗi phút, quét lịch sự kiện đã đặt (schedule/create) và tự động bật/tắt đúng giờ.
  async scheduled(event, env, ctx) {
    try {
      const stub = getGuildStub(env);
      await stub.fetch(new Request('https://internal/schedule/check-due', { method: 'POST' }));
    } catch (err) { /* lỗi cron không được làm crash worker, chỉ bỏ qua lần chạy này */ }
  },
};
