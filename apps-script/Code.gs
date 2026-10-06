/*
 * 午餐訂餐：Google Apps Script 後端
 * 同一個專案裡還要有 Logic.gs（內容與 GitHub 上的 logic.js 相同）。
 * 第一次使用先執行 setup()，再部署成「網頁應用程式」。
 */

const TZ = 'Asia/Taipei';
const CELL_FORMATS = { text: '@', number: '0', datetime: 'yyyy-mm-dd hh:mm' };

function doGet(e) {
  return respond_((e && e.parameter) || {});
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: '資料格式錯誤' });
  }
  return respond_(req);
}

function respond_(req) {
  const isWrite = req.action !== 'state';
  const lock = LockService.getScriptLock();
  if (isWrite && !lock.tryLock(15000)) return json_({ ok: false, error: '同時太多人送出，請再按一次' });
  try {
    const api = createLunchApi(sheetDb_(), sheetEnv_());
    return json_({ ok: true, data: api.handle(req) });
  } catch (err) {
    return json_({ ok: false, error: err.message || String(err) });
  } finally {
    if (isWrite) lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sheetEnv_() {
  return {
    pin: PropertiesService.getScriptProperties().getProperty('ADMIN_PIN') || '',
    uuid: function () { return Utilities.getUuid().replace(/-/g, '').slice(0, 10); },
    now: function () {
      const d = new Date();
      return { date: Utilities.formatDate(d, TZ, 'yyyy-MM-dd'), time: Utilities.formatDate(d, TZ, 'HH:mm'), stamp: d };
    },
    resolveUrl: expandShortUrl_,
  };
}

// maps.app.goo.gl 這類短網址要跟著轉址，才看得到店名
function expandShortUrl_(url) {
  for (let i = 0; i < 5 && /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl|g\.co)\//i.test(url); i++) {
    const headers = UrlFetchApp.fetch(url, { followRedirects: false, muteHttpExceptions: true }).getHeaders();
    const next = headers.Location || headers.location;
    if (!next) break;
    url = next;
  }
  return url;
}

/* ---------- 試算表讀寫 ---------- */

function sheetDb_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  function sheetOf(table) {
    const sh = ss.getSheetByName(LUNCH_TABLES[table].sheet);
    if (!sh) throw new Error('找不到工作表「' + LUNCH_TABLES[table].sheet + '」，請先在 Apps Script 執行 setup');
    return sh;
  }

  // 回傳 [{ row: 試算表列號, data: 物件 }]，略過空白列
  function rows(table) {
    const cols = LUNCH_TABLES[table].cols;
    const sh = sheetOf(table);
    const last = sh.getLastRow();
    if (last < 2) return [];
    return sh.getRange(2, 1, last - 1, cols.length).getValues()
      .map(function (values, i) { return { row: i + 2, data: fromCells_(cols, values) }; })
      .filter(function (r) { return r.data[cols[0][0]] !== ''; });
  }

  return {
    all: function (table) {
      return rows(table).map(function (r) { return r.data; });
    },

    insert: function (table, objs) {
      if (!objs.length) return;
      const cols = LUNCH_TABLES[table].cols;
      const sh = sheetOf(table);
      const start = sh.getLastRow() + 1;
      const extra = start + objs.length - 1 - sh.getMaxRows();
      if (extra > 0) sh.insertRowsAfter(sh.getMaxRows(), extra);
      sh.getRange(start, 1, objs.length, cols.length)
        .setNumberFormats(objs.map(function () { return cols.map(function (c) { return CELL_FORMATS[c[2]]; }); }))
        .setValues(objs.map(function (o) { return toCells_(cols, o); }));
    },

    remove: function (table, pred) {
      const sh = sheetOf(table);
      const hits = rows(table).filter(function (r) { return pred(r.data); });
      // 試算表不允許刪光所有非凍結列，先補一列空白
      if (hits.length && hits.length >= sh.getMaxRows() - 1) sh.insertRowAfter(sh.getMaxRows());
      hits.reverse().forEach(function (r) { sh.deleteRow(r.row); });
      return hits.length;
    },

    update: function (table, pred, patch) {
      const cols = LUNCH_TABLES[table].cols;
      const sh = sheetOf(table);
      const hits = rows(table).filter(function (r) { return pred(r.data); });
      hits.forEach(function (r) {
        cols.forEach(function (c, i) {
          if (!(c[0] in patch)) return;
          sh.getRange(r.row, i + 1).setNumberFormat(CELL_FORMATS[c[2]]).setValue(toCell_(c[2], patch[c[0]]));
        });
      });
      return hits.length;
    },
  };
}

function fromCells_(cols, values) {
  const obj = {};
  cols.forEach(function (c, i) {
    const v = values[i];
    if (c[2] === 'number') obj[c[0]] = Number(v) || 0;
    else if (v instanceof Date) obj[c[0]] = Utilities.formatDate(v, TZ, c[2] === 'datetime' ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd');
    else obj[c[0]] = String(v);
  });
  return obj;
}

function toCells_(cols, obj) {
  return cols.map(function (c) { return toCell_(c[2], obj[c[0]]); });
}

function toCell_(type, v) {
  if (type === 'number') return Number(v) || 0;
  if (type === 'datetime') return v instanceof Date ? v : (v || '');
  return v == null ? '' : String(v);
}

/* ---------- 第一次使用：建立工作表 ---------- */

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(TZ);
  Object.keys(LUNCH_TABLES).forEach(function (key) {
    const def = LUNCH_TABLES[key];
    const sh = ss.getSheetByName(def.sheet) || ss.insertSheet(def.sheet);
    sh.getRange(1, 1, 1, def.cols.length)
      .setValues([def.cols.map(function (c) { return c[1]; })])
      .setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  // 新試算表預設的空白工作表用不到，順手移除
  ['工作表1', 'Sheet1'].forEach(function (name) {
    const sh = ss.getSheetByName(name);
    if (sh && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });
  Logger.log('完成：已建立「店家」「菜單」「開單」「訂單」四個工作表');
}
