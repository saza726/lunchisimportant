/*
 * 午餐訂餐：共用邏輯
 * 網頁（示範模式、統計）和 Apps Script 後端都載入這一份。
 * 放進 Apps Script 時，新增一個名為 Logic 的指令碼檔，整份貼上即可。
 */

const LUNCH_TABLES = {
  stores: { sheet: '店家', cols: [
    ['id', '編號', 'text'], ['name', '店名', 'text'], ['mapUrl', '地圖網址', 'text'],
    ['phone', '電話', 'text'], ['createdAt', '建立時間', 'datetime']] },
  menu: { sheet: '菜單', cols: [
    ['storeId', '店家編號', 'text'], ['item', '品項', 'text'], ['price', '價格', 'number']] },
  rounds: { sheet: '開單', cols: [
    ['id', '編號', 'text'], ['date', '日期', 'text'], ['storeId', '店家編號', 'text'],
    ['deadline', '截止時間', 'text'], ['status', '狀態', 'text']] },
  orders: { sheet: '訂單', cols: [
    ['id', '編號', 'text'], ['roundId', '開單編號', 'text'], ['date', '日期', 'text'],
    ['createdAt', '點餐時間', 'datetime'], ['name', '姓名', 'text'], ['storeName', '店家', 'text'],
    ['item', '品項', 'text'], ['price', '單價', 'number'], ['qty', '數量', 'number'],
    ['note', '備註', 'text'], ['paid', '付款', 'text']] },
};

const LUNCH_ADMIN_ACTIONS = ['checkPin', 'resolveMap', 'saveStore', 'deleteStore', 'openRound', 'updateRound', 'setPaid'];
const ROUND_OPEN = '進行中';
const ROUND_CLOSED = '已截止';
const ORDER_PAID = '已付';

/* ---------- 文字解析 ---------- */

// 全形英數符號轉半形，方便解析「排骨飯　＄９０」這類菜單
function toHalfWidth(s) {
  return String(s == null ? '' : s)
    .replace(/[！-～]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/　/g, ' ');
}

// 每行一項，最後的數字當價格：「排骨飯 90」「雞腿飯......$110元」都可以
function parseMenuText(text) {
  const items = [];
  const skipped = [];
  const seen = {};
  String(text == null ? '' : text).split(/\r?\n/).forEach(function (raw) {
    const line = toHalfWidth(raw).trim();
    if (!line) return;
    const m = line.match(/^(.*?)\s*(?:NT\$?|\$)?\s*(\d{1,6})\s*(?:元|塊)?$/i);
    const name = m ? m[1].replace(/[\s.…:$,_|\-–—]+$/, '').trim() : '';
    if (!m || !name) { skipped.push(line); return; }
    items.push({ item: name, price: Number(m[2]), duplicate: !!seen[name] });
    seen[name] = true;
  });
  return { items: items, skipped: skipped };
}

// 從 Google 地圖網址取出店名；短網址（maps.app.goo.gl）要先展開才讀得到
function parseMapName(url) {
  const s = String(url || '');
  let raw = '';
  let m = s.match(/\/maps\/place\/([^\/@?#]+)/);
  if (m) raw = m[1];
  else if ((m = s.match(/[?&](?:q|query)=([^&#]+)/))) raw = m[1];
  if (!raw) return '';
  let name;
  try { name = decodeURIComponent(raw.replace(/\+/g, ' ')); } catch (e) { return ''; }
  name = name.split(/[,，]/)[0].trim();
  return /^-?\d+(\.\d+)?$/.test(name) ? '' : name; // 只有座標就當作沒有店名
}

/* ---------- 統計 ---------- */

function summarizeOrders(orders) {
  const byItem = {};
  const byPerson = {};
  const itemOrder = [];
  const personOrder = [];
  let qty = 0, amount = 0, unpaid = 0;
  (orders || []).forEach(function (o) {
    const sub = o.price * o.qty;
    qty += o.qty;
    amount += sub;
    if (!byItem[o.item]) { byItem[o.item] = { item: o.item, price: o.price, qty: 0, notes: {} }; itemOrder.push(o.item); }
    const it = byItem[o.item];
    it.qty += o.qty;
    if (o.note) it.notes[o.note] = (it.notes[o.note] || 0) + o.qty;
    if (!byPerson[o.name]) { byPerson[o.name] = { name: o.name, lines: [], amount: 0, paid: true }; personOrder.push(o.name); }
    const p = byPerson[o.name];
    p.lines.push(o);
    p.amount += sub;
    p.paid = p.paid && !!o.paid;
  });
  const people = personOrder.map(function (n) { return byPerson[n]; });
  people.forEach(function (p) { if (!p.paid) unpaid += p.amount; });
  return {
    items: itemOrder.map(function (k) { return byItem[k]; }).sort(function (a, b) { return b.qty - a.qty; }),
    people: people,
    qty: qty, amount: amount, unpaid: unpaid,
  };
}

function money(n) { return 'NT$' + Number(n || 0).toLocaleString('en-US'); }

function noteText(notes) {
  return Object.keys(notes).map(function (k) { return k + '×' + notes[k]; }).join('、');
}

// 打電話或傳訊息給店家用
function buildStoreText(summary) {
  const lines = summary.items.map(function (it) {
    const n = noteText(it.notes);
    return it.item + ' ×' + it.qty + (n ? '（' + n + '）' : '');
  });
  lines.push('共 ' + summary.qty + ' 份，' + money(summary.amount));
  return lines.join('\n');
}

// 收錢對帳用
function buildPaymentText(summary, title) {
  const lines = title ? [title] : [];
  summary.people.forEach(function (p) {
    const what = p.lines.map(function (o) { return o.item + '×' + o.qty; }).join('、');
    lines.push(p.name + '　' + what + '　' + money(p.amount) + (p.paid ? '（已付）' : ''));
  });
  lines.push('合計 ' + money(summary.amount) + '，未收 ' + money(summary.unpaid));
  return lines.join('\n');
}

/* ---------- 後端動作 ---------- */

/*
 * db：{ all(table), insert(table, rows), remove(table, pred), update(table, pred, patch) }
 * env：{ pin, uuid(), now() → { date: 'yyyy-MM-dd', time: 'HH:mm', stamp }, resolveUrl(url)? }
 */
function createLunchApi(db, env) {
  function fail(msg) { throw new Error(msg); }
  function text(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 100); }
  function findOne(table, pred) { return db.all(table).filter(pred)[0] || null; }

  function roundState(round, now) {
    const manual = round.status === ROUND_CLOSED;
    const late = !manual && (round.date !== now.date || (round.deadline && now.time > round.deadline));
    return Object.assign({}, round, { isOpen: !manual && !late, closedBy: manual ? 'manual' : late ? 'time' : null });
  }

  function openRoundOrFail(roundId, now) {
    const round = findOne('rounds', function (r) { return r.id === roundId; }) || fail('找不到這次開單，請重新整理');
    if (!roundState(round, now).isOpen) fail('已經截止，要改單請找負責人');
    return round;
  }

  function checkTime(t) {
    t = text(t, 5);
    if (t && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) fail('截止時間格式要像 11:30');
    return t;
  }

  const actions = {
    state: function () {
      const now = env.now();
      const menu = db.all('menu');
      const stores = db.all('stores').map(function (s) {
        return {
          id: s.id, name: s.name, mapUrl: s.mapUrl, phone: s.phone,
          menu: menu.filter(function (m) { return m.storeId === s.id; }).map(function (m) { return { item: m.item, price: m.price }; }),
        };
      });
      const today = db.all('rounds').filter(function (r) { return r.date === now.date; });
      const round = today.length ? roundState(today[today.length - 1], now) : null;
      const orders = !round ? [] : db.all('orders')
        .filter(function (o) { return o.roundId === round.id; })
        .map(function (o) { return { name: o.name, item: o.item, price: o.price, qty: o.qty, note: o.note, paid: o.paid === ORDER_PAID }; });
      return {
        now: { date: now.date, time: now.time },
        pinRequired: !!env.pin,
        round: round,
        store: round ? stores.filter(function (s) { return s.id === round.storeId; })[0] || null : null,
        stores: stores,
        orders: orders,
      };
    },

    checkPin: function () { return true; },

    resolveMap: function (req) {
      let url = text(req.url, 1000);
      if (!/^https?:\/\//i.test(url)) fail('請貼上完整的 Google 地圖網址');
      if (env.resolveUrl) url = env.resolveUrl(url);
      return { name: parseMapName(url) };
    },

    saveStore: function (req) {
      const name = text(req.name, 60) || fail('請填店名');
      const items = (req.items || []).map(function (it) {
        const item = text(it.item, 60);
        const price = Number(it.price);
        if (!item) fail('有品項沒有名稱');
        if (!(price >= 0 && price <= 100000 && Math.floor(price) === price)) fail('「' + item + '」的價格不正確');
        return { item: item, price: price };
      });
      if (!items.length) fail('菜單至少要一項');
      const seen = {};
      items.forEach(function (it) { if (seen[it.item]) fail('品項重複：' + it.item); seen[it.item] = true; });
      const fields = { name: name, mapUrl: text(req.mapUrl, 1000), phone: text(req.phone, 30) };
      let id = text(req.id, 40);
      if (id) {
        if (!db.update('stores', function (s) { return s.id === id; }, fields)) fail('找不到這家店');
        db.remove('menu', function (m) { return m.storeId === id; });
      } else {
        id = 's_' + env.uuid();
        db.insert('stores', [Object.assign({ id: id, createdAt: env.now().stamp }, fields)]);
      }
      db.insert('menu', items.map(function (it) { return { storeId: id, item: it.item, price: it.price }; }));
      return { id: id };
    },

    deleteStore: function (req) {
      const id = text(req.id, 40);
      if (!db.remove('stores', function (s) { return s.id === id; })) fail('找不到這家店');
      db.remove('menu', function (m) { return m.storeId === id; });
      return {};
    },

    openRound: function (req) {
      const storeId = text(req.storeId, 40);
      findOne('stores', function (s) { return s.id === storeId; }) || fail('請先選店家');
      const id = 'r_' + env.uuid();
      db.insert('rounds', [{ id: id, date: env.now().date, storeId: storeId, deadline: checkTime(req.deadline), status: ROUND_OPEN }]);
      return { id: id };
    },

    updateRound: function (req) {
      const patch = {};
      if ('open' in req) patch.status = req.open ? ROUND_OPEN : ROUND_CLOSED;
      if ('deadline' in req) patch.deadline = checkTime(req.deadline);
      if (!db.update('rounds', function (r) { return r.id === req.roundId; }, patch)) fail('找不到這次開單');
      return {};
    },

    submitOrder: function (req) {
      const now = env.now();
      const round = openRoundOrFail(req.roundId, now);
      const name = text(req.name, 30) || fail('請填姓名');
      const store = findOne('stores', function (s) { return s.id === round.storeId; }) || fail('這家店已被刪除，請找負責人');
      const prices = {};
      db.all('menu').forEach(function (m) { if (m.storeId === store.id) prices[m.item] = m.price; });
      const lines = (req.lines || [])
        .map(function (l) { return { item: text(l.item, 60), qty: Number(l.qty), note: text(l.note, 60) }; })
        .filter(function (l) { return l.qty !== 0; });
      if (!lines.length) fail('請至少點一項');
      lines.forEach(function (l) {
        if (!Object.prototype.hasOwnProperty.call(prices, l.item)) fail('菜單沒有「' + l.item + '」，請重新整理');
        if (!(l.qty >= 1 && l.qty <= 50 && Math.floor(l.qty) === l.qty)) fail('「' + l.item + '」的數量不正確');
      });
      // 同一人重送就整筆取代，方便改單
      db.remove('orders', function (o) { return o.roundId === round.id && o.name === name; });
      db.insert('orders', lines.map(function (l) {
        return {
          id: 'o_' + env.uuid(), roundId: round.id, date: round.date, createdAt: now.stamp, name: name,
          storeName: store.name, item: l.item, price: prices[l.item], qty: l.qty, note: l.note, paid: '',
        };
      }));
      return {};
    },

    cancelOrder: function (req) {
      const round = openRoundOrFail(req.roundId, env.now());
      const name = text(req.name, 30);
      if (!db.remove('orders', function (o) { return o.roundId === round.id && o.name === name; })) fail('找不到你的點單');
      return {};
    },

    setPaid: function (req) {
      const name = text(req.name, 30);
      const n = db.update('orders', function (o) { return o.roundId === req.roundId && o.name === name; }, { paid: req.paid ? ORDER_PAID : '' });
      if (!n) fail('找不到這個人的點單');
      return {};
    },
  };

  // 寫入動作順便回傳最新狀態，網頁少等一次連線
  function handle(req) {
    req = req || {};
    const fn = Object.prototype.hasOwnProperty.call(actions, req.action) ? actions[req.action] : null;
    if (!fn) fail('未知的動作：' + req.action);
    if (LUNCH_ADMIN_ACTIONS.indexOf(req.action) >= 0 && env.pin && String(req.pin || '') !== String(env.pin)) fail('管理密碼錯誤');
    if (req.action === 'state') return fn(req);
    const result = fn(req);
    return { result: result, state: actions.state() };
  }

  return { handle: handle };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    LUNCH_TABLES: LUNCH_TABLES, parseMenuText: parseMenuText, parseMapName: parseMapName,
    summarizeOrders: summarizeOrders, buildStoreText: buildStoreText, buildPaymentText: buildPaymentText,
    createLunchApi: createLunchApi, money: money,
  };
}
