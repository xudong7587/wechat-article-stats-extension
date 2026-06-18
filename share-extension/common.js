const API_BASE = "https://api.weixin.qq.com";
const TOKEN_URL = `${API_BASE}/cgi-bin/stable_token`;

const ENDPOINTS = {
  "totaldetail": "/datacube/getarticletotaldetail",
  "legacy-summary": "/datacube/getarticlesummary",
  "legacy-total": "/datacube/getarticletotal"
};

const FIELD_LABELS = {
  title: "文章标题",
  ref_date: "文章日期",
  source_type: "来源",
  stat_date: "统计截至日期",
  content_url: "文章链接",
  read_user: "阅读/播放数",
  like_user: "点赞/推荐",
  share_user: "转发",
  zaikan_user: "喜欢",
  comment_count: "留言/评论",
  collection_user: "收藏",
  read_finish_rate: "阅读完成率",
  read_avg_activetime: "平均阅读时长(分钟)",
  read_subscribe_user: "阅读后关注"
};

const DEFAULT_FIELDS = [
  "title",
  "ref_date",
  "source_type",
  "read_user",
  "like_user",
  "share_user",
  "zaikan_user",
  "comment_count"
];

const SETTINGS_KEY = "sharePluginSettings";
const TOKEN_KEY = "sharePluginToken";

function defaultSettings() {
  return {
    appid: "",
    appsecret: "",
    mode: "totaldetail",
    rowMode: "latest",
    selectedFields: DEFAULT_FIELDS.slice()
  };
}

function parseCsvLine(line) {
  const result = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function parseCsv(text) {
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map(item => item.trim());
  return lines.slice(1).map(line => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    return row;
  });
}

function parseVideoDate(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const match = text.match(/(20\d{2})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!match) return text.replace(/\//g, "-").slice(0, 10);
  return `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`;
}

function normalizeVideoRows(rows, start, end) {
  return rows.map(raw => ({
    source_type: "视频号",
    ref_date: parseVideoDate(raw["发布时间"]),
    stat_date: parseVideoDate(raw["发布时间"]),
    title: String(raw["视频描述"] || "").trim(),
    content_url: String(raw["视频ID"] || "").trim(),
    read_user: String(raw["播放量"] || "").trim(),
    like_user: String(raw["推荐"] || "").trim(),
    share_user: String(raw["分享量"] || "").trim(),
    zaikan_user: String(raw["喜欢"] || "").trim(),
    comment_count: String(raw["评论量"] || "").trim(),
    collection_user: "",
    read_finish_rate: String(raw["完播率"] || "").trim(),
    read_avg_activetime: String(raw["平均播放时长"] || "").trim(),
    read_subscribe_user: String(raw["关注量"] || "").trim()
  })).filter(row => {
    if (!row.title || !row.ref_date) return false;
    if (start && row.ref_date < start) return false;
    if (end && row.ref_date > end) return false;
    return true;
  });
}

async function getStored(keys) {
  return chrome.storage.local.get(keys);
}

async function saveStored(payload) {
  return chrome.storage.local.set(payload);
}

async function loadSettings() {
  const data = await getStored(SETTINGS_KEY);
  return {...defaultSettings(), ...(data[SETTINGS_KEY] || {})};
}

async function saveSettings(settings) {
  await saveStored({[SETTINGS_KEY]: {...defaultSettings(), ...settings}});
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function yesterdayDate() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return date;
}

function monthStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function dateRange(start, end) {
  const result = [];
  const current = new Date(`${start}T00:00:00`);
  const last = new Date(`${end}T00:00:00`);
  if (current > last) throw new Error("开始日期不能晚于结束日期。");
  const max = new Date(`${formatDate(yesterdayDate())}T00:00:00`);
  if (last > max) throw new Error(`结束日期最大只能到昨天：${formatDate(max)}。`);
  while (current <= last) {
    result.push(formatDate(current));
    current.setDate(current.getDate() + 1);
  }
  return result;
}

function wechatErrorMessage(errcode, errmsg, endpoint) {
  const hints = {
    40001: "access_token 无效或不是最新，请检查 AppSecret 和账号是否匹配。",
    40013: "AppID 不合法，请检查 AppID。",
    40125: "AppSecret 无效，请检查 AppSecret。",
    40164: "当前电脑 IP 不在公众号 IP 白名单里，请到微信公众平台基本配置中添加出口 IP。",
    48001: "接口权限不足，通常需要认证账号并开通对应权限。",
    61500: "日期格式错误或日期范围不符合接口要求。",
    61501: "日期范围超过接口限制。"
  };
  return `微信接口返回错误 ${errcode}：${errmsg}。接口：${endpoint}。提示：${hints[errcode] || "请查看微信接口错误详情。"}`;
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {"Content-Type": "application/json; charset=utf-8"},
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`接口返回无法解析：${text.slice(0, 120)}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
  return data;
}

async function getAccessToken(settings, forceRefresh = false) {
  if (!settings.appid || !settings.appsecret) throw new Error("请先在工具设置里填写 AppID 和 AppSecret。");
  const cached = await getStored(TOKEN_KEY);
  const token = cached[TOKEN_KEY];
  if (!forceRefresh && token?.access_token && token.expires_at > Date.now()) {
    return token.access_token;
  }
  const data = await postJson(TOKEN_URL, {
    grant_type: "client_credential",
    appid: settings.appid,
    secret: settings.appsecret,
    force_refresh: forceRefresh
  });
  if (data.errcode && data.errcode !== 0) throw new Error(wechatErrorMessage(data.errcode, data.errmsg || "", "stable_token"));
  if (!data.access_token) throw new Error("微信没有返回 access_token，请检查 AppID/AppSecret。");
  await saveStored({
    [TOKEN_KEY]: {
      access_token: data.access_token,
      expires_at: Date.now() + Math.max(60, Number(data.expires_in || 7200) - 300) * 1000
    }
  });
  return data.access_token;
}

async function datacube(settings, mode, day, forceRefreshToken = false) {
  let token = await getAccessToken(settings, forceRefreshToken);
  const endpoint = ENDPOINTS[mode];
  const url = `${API_BASE}${endpoint}?access_token=${encodeURIComponent(token)}`;
  const payload = {begin_date: day, end_date: day};
  let data = await postJson(url, payload);
  if (data.errcode && data.errcode !== 0) {
    if (data.errcode === 40001 && !forceRefreshToken) {
      token = await getAccessToken(settings, true);
      data = await postJson(`${API_BASE}${endpoint}?access_token=${encodeURIComponent(token)}`, payload);
    }
    if (data.errcode && data.errcode !== 0) throw new Error(wechatErrorMessage(data.errcode, data.errmsg || "", endpoint));
  }
  return data;
}

function centsToYuan(value) {
  if (value === "" || value === null || value === undefined) return "";
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? (number / 100).toFixed(2) : "";
}

function flattenTotaldetail(dayData) {
  const rows = [];
  const isDelay = dayData.is_delay;
  for (const article of dayData.list || []) {
    const base = {
      source_type: "公众号",
      ref_date: article.ref_date || "",
      msgid: article.msgid || "",
      title: article.title || "",
      content_url: article.content_url || "",
      publish_type: article.publish_type || "",
      is_delay: isDelay
    };
    for (const detail of article.detail_list || []) {
      rows.push({
        ...base,
        stat_date: detail.stat_date || "",
        read_user: detail.read_user ?? "",
        share_user: detail.share_user ?? "",
        zaikan_user: detail.zaikan_user ?? "",
        like_user: detail.like_user ?? "",
        comment_count: detail.comment_count ?? "",
        collection_user: detail.collection_user ?? "",
        praise_money: detail.praise_money ?? "",
        praise_money_yuan: centsToYuan(detail.praise_money),
        read_subscribe_user: detail.read_subscribe_user ?? "",
        read_delivery_rate: detail.read_delivery_rate ?? "",
        read_finish_rate: detail.read_finish_rate ?? "",
        read_avg_activetime: detail.read_avg_activetime ?? ""
      });
    }
  }
  return rows;
}

function flattenLegacy(mode, dayData) {
  const rows = [];
  for (const article of dayData.list || []) {
    const base = {
      source_type: "公众号",
      ref_date: article.ref_date || "",
      msgid: article.msgid || "",
      title: article.title || ""
    };
    if (mode === "legacy-total") {
      for (const detail of article.details || []) rows.push({...base, ...detail});
    } else {
      rows.push({...base, stat_date: article.ref_date || "", ...article});
    }
  }
  return rows;
}

function latestRowsByArticle(rows) {
  const latest = new Map();
  for (const row of rows) {
    const key = String(row.msgid || row.content_url || row.title || "");
    if (!key) continue;
    const current = latest.get(key);
    if (!current || String(row.stat_date || "") >= String(current.stat_date || "")) latest.set(key, row);
  }
  return [...latest.values()];
}

function sortRows(rows) {
  return rows.slice().sort((a, b) => String(a.ref_date || "").localeCompare(String(b.ref_date || "")) || String(a.title || "").localeCompare(String(b.title || ""), "zh-CN"));
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function makeCsv(rows, fields) {
  const header = fields.map(field => FIELD_LABELS[field] || field).map(csvEscape).join(",");
  const lines = rows.map(row => fields.map(field => csvEscape(row[field])).join(","));
  return `\uFEFF${[header, ...lines].join("\r\n")}`;
}

async function downloadCsv(filename, csvText) {
  const blob = new Blob([csvText], {type: "text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({url, filename, saveAs: false, conflictAction: "uniquify"});
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
