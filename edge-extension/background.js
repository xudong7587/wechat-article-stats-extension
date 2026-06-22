const LOCAL_BASE = "http://127.0.0.1:8765";
const STATUS_KEY = "statusLog";
const RUNNING_KEY = "taskRunning";
const CANCEL_KEY = "cancelRequested";

chrome.runtime.onInstalled.addListener(() => {
  console.log("公众号数据助手已安装");
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function nowText() {
  return new Date().toLocaleTimeString("zh-CN", {hour12: false});
}

function storageGet(key) {
  return new Promise(resolve => chrome.storage.local.get(key, resolve));
}

function storageSet(data) {
  return new Promise(resolve => chrome.storage.local.set(data, resolve));
}

async function appendStatus(text, replace = false) {
  const line = `[${nowText()}] ${text}`;
  if (replace) {
    await storageSet({[STATUS_KEY]: line});
    return;
  }
  const data = await storageGet(STATUS_KEY);
  const current = String(data[STATUS_KEY] || "").trim();
  const next = current ? `${current}\n${line}` : line;
  await storageSet({[STATUS_KEY]: next.split("\n").slice(-120).join("\n")});
}

async function clearCancel() {
  await storageSet({[CANCEL_KEY]: false});
}

async function requestCancel() {
  await storageSet({[CANCEL_KEY]: true});
  await appendStatus("已请求停止当前任务，正在收尾...");
}

async function ensureNotCancelled() {
  const data = await storageGet(CANCEL_KEY);
  if (data[CANCEL_KEY]) throw new Error("任务已停止。");
}

function searchDownloads(query) {
  return new Promise(resolve => chrome.downloads.search(query, items => resolve(items || [])));
}

function executeScriptWithTimeout(options, timeoutMs = 15000) {
  return Promise.race([
    chrome.scripting.executeScript(options),
    new Promise((_, reject) => setTimeout(() => reject(new Error("向视频号页面发送下载指令超时，请刷新视频号页面后重试。")), timeoutMs))
  ]);
}

async function latestChannelsCsv(startedAfter = null) {
  const since = startedAfter || new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
  const items = await searchDownloads({
    state: "complete",
    startedAfter: since,
    orderBy: ["-startTime"],
    limit: 80
  });
  const csvItems = items.filter(item => {
    const filename = String(item.filename || "");
    return filename.toLowerCase().endsWith(".csv");
  });
  const channelsItems = csvItems.filter(item => {
    const filename = String(item.filename || "");
    const url = String(item.url || "");
    const finalUrl = String(item.finalUrl || "");
    return /视频号|动态数据明细|channels|wechat_channels/i.test(filename)
      || url.startsWith("blob:https://channels.weixin.qq.com/")
      || finalUrl.startsWith("blob:https://channels.weixin.qq.com/");
  });
  return channelsItems[0] || csvItems[0] || null;
}

async function recentCsvNames(startedAfter = null) {
  const since = startedAfter || new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const items = await searchDownloads({
    state: "complete",
    startedAfter: since,
    orderBy: ["-startTime"],
    limit: 8
  });
  return items
    .filter(item => String(item.filename || "").toLowerCase().endsWith(".csv"))
    .map(item => String(item.filename || "").split(/[\\/]/).pop())
    .filter(Boolean);
}

async function latestRegionExcels(startedAfter = null, limit = 100) {
  const since = startedAfter || new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const items = await searchDownloads({
    state: "complete",
    startedAfter: since,
    orderBy: ["-startTime"],
    limit
  });
  return items.filter(item => {
    const filename = String(item.filename || "");
    const name = filename.split(/[\\/]/).pop() || filename;
    if (!/\.(xls|xlsx)$/i.test(filename)) return false;
    if (/泰绩优地域战报|公众号视频号合并运营表|视频号运营表/i.test(name)) return false;
    return /数据明细|appmsg|analysis|xls/i.test(name) || true;
  });
}

async function waitForRegionExcels(startedAfter, expectedCount, timeoutMs) {
  const startedAt = Date.now();
  let lastNoticeAt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    await ensureNotCancelled();
    const items = await latestRegionExcels(startedAfter);
    const unique = uniqueDownloadFilenames(items);
    if (unique.length >= expectedCount) return unique;
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    if (seconds > 0 && seconds % 10 === 0 && seconds !== lastNoticeAt) {
      lastNoticeAt = seconds;
      await appendStatus(`地域 Excel 已完成 ${unique.length}/${expectedCount} 个，继续等待...`);
    }
    await sleep(1000);
  }
  return uniqueDownloadFilenames(await latestRegionExcels(startedAfter));
}

function uniqueDownloadFilenames(items) {
  const seen = new Set();
  const result = [];
  for (const item of items || []) {
    const filename = String(item.filename || "");
    if (!filename || seen.has(filename)) continue;
    seen.add(filename);
    result.push(filename);
  }
  return result;
}

async function waitForChannelsCsv(startedAfter, timeoutMs) {
  const startedAt = Date.now();
  let lastNoticeAt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    await ensureNotCancelled();
    const item = await latestChannelsCsv(startedAfter);
    if (item?.filename) return item.filename;
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    if (seconds > 0 && seconds % 10 === 0 && seconds !== lastNoticeAt) {
      lastNoticeAt = seconds;
      const names = await recentCsvNames(startedAfter);
      await appendStatus(`视频号 CSV 还在下载或等待确认，已等待 ${seconds} 秒...${names.length ? ` 最近 CSV：${names.join("，")}` : ""}`);
    }
    await sleep(1000);
  }
  return "";
}

async function clickChannelsExportButton() {
  const normalize = (text) => String(text || "").replace(/\s+/g, " ").trim();
  const allElements = (root = document) => {
    const result = [];
    const walk = (node) => {
      if (!node) return;
      const elements = node.querySelectorAll ? Array.from(node.querySelectorAll("*")) : [];
      for (const el of elements) {
        result.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(root);
    return result;
  };
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const clickElement = (el) => {
    el.scrollIntoView({block: "center", inline: "center"});
    const rect = el.getBoundingClientRect();
    const x = rect.left + Math.min(rect.width / 2, Math.max(8, rect.width - 8));
    const y = rect.top + Math.min(rect.height / 2, Math.max(8, rect.height - 8));
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      el.dispatchEvent(new MouseEvent(type, {bubbles: true, cancelable: true, view: window, clientX: x, clientY: y}));
    }
    if (typeof el.click === "function") el.click();
  };
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const labelOf = (el) => normalize([
    el.innerText,
    el.textContent,
    el.getAttribute("aria-label"),
    el.getAttribute("title"),
    el.getAttribute("download"),
    el.getAttribute("href"),
    el.id,
    typeof el.className === "string" ? el.className : "",
    el.getAttribute("class")
  ].join(" "));
  const clickableParent = (el) => {
    let current = el;
    for (let depth = 0; current && depth < 5; depth += 1) {
      if (current.tagName === "BUTTON" || current.tagName === "A" || current.getAttribute("role") === "button" || current.onclick) return current;
      current = current.parentElement;
    }
    return el;
  };
  const findBlobDownload = () => {
    const anchors = allElements()
      .filter(el => el.tagName === "A")
      .map(el => ({el, href: String(el.getAttribute("href") || el.href || ""), label: labelOf(el)}))
      .filter(item => /blob:https:\/\/channels\.weixin\.qq\.com\//i.test(item.href) || /\.csv(\?|$)/i.test(item.href) || /csv|动态数据|明细|导出|下载/i.test(item.label));
    return anchors.find(item => /blob:https:\/\/channels\.weixin\.qq\.com\//i.test(item.href)) || anchors[0] || null;
  };
  const scoreElement = (el) => {
    if (!visible(el)) return 0;
    const label = labelOf(el);
    const rect = el.getBoundingClientRect();
    let score = 0;
    if (/导出|下载|导出数据|下载明细|下载数据|数据明细|export|download/i.test(label)) score += 80;
    if (/blob:https:\/\/channels\.weixin\.qq\.com\//i.test(label)) score += 120;
    if (/export|download|csv|btn_download|icon-download|download-icon/i.test(label)) score += 45;
    if (el.tagName === "A" && el.href) score += 25;
    if (el.tagName === "BUTTON" || el.getAttribute("role") === "button") score += 20;
    if (rect.top >= 0 && rect.top < Math.max(420, window.innerHeight * 0.65)) score += 8;
    if (rect.width <= 260 && rect.height <= 90) score += 5;
    if (/删除|取消|返回|重置|筛选|查询|搜索|刷新|登录|退出|清空/.test(label)) score -= 100;
    return score;
  };
  const directBlob = findBlobDownload();
  if (directBlob) {
    clickElement(directBlob.el);
    return {ok: true, text: directBlob.label || directBlob.href || "CSV 下载链接"};
  }
  const candidates = allElements()
    .map(el => {
      const target = clickableParent(el);
      const text = normalize(`${labelOf(target)} ${labelOf(el)}`).slice(0, 220);
      return {el: target, score: Math.max(scoreElement(target), scoreElement(el)), text};
    })
    .filter(item => item.score > 0 && visible(item.el))
    .sort((a, b) => b.score - a.score);
  const unique = [];
  const seen = new Set();
  for (const item of candidates) {
    if (seen.has(item.el)) continue;
    seen.add(item.el);
    unique.push(item);
  }
  const best = unique.find(item => item.score >= 65);
  if (!best) return {ok: false, candidates: unique.slice(0, 8).map(item => `${item.score}: ${item.text}`)};
  clickElement(best.el);
  for (let index = 0; index < 8; index += 1) {
    await sleep(500);
    const blob = findBlobDownload();
    if (blob) {
      clickElement(blob.el);
      return {ok: true, text: `${best.text || "导出"} -> ${blob.label || "CSV 下载链接"}`};
    }
  }
  return {ok: true, text: best.text || "导出"};
}

function triggerDownloadQueue(links) {
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const randomDelay = () => 3000 + Math.floor(Math.random() * 2001);
  const download = (url) => {
    let frame = document.getElementById("wechatRegionDownloadFrame");
    if (!frame) {
      frame = document.createElement("iframe");
      frame.id = "wechatRegionDownloadFrame";
      frame.style.display = "none";
      document.body.appendChild(frame);
    }
    frame.src = url;
  };
  (async () => {
    for (let index = 0; index < links.length; index += 1) {
      if (index > 0) await sleep(randomDelay());
      download(links[index].url);
    }
  })();
}

async function waitForJob(jobId) {
  while (true) {
    await ensureNotCancelled();
    const response = await fetch(`${LOCAL_BASE}/api/job?id=${encodeURIComponent(jobId)}`);
    const job = await response.json();
    if (job.status === "done") return job;
    if (job.status === "error") throw new Error((job.log || []).slice(-1)[0] || "任务失败");
    await sleep(900);
  }
}

async function runCombinedExport(reportPayload, videoFiles, replaceStatus = false) {
  const includeArticles = reportPayload.includeArticles !== false;
  await appendStatus(includeArticles ? "正在生成公众号 + 视频号合并表..." : "正在生成视频号数据表...", replaceStatus);
  await ensureNotCancelled();
  const response = await fetch(`${LOCAL_BASE}/api/combined-export`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({...reportPayload, videoFiles, deleteVideoFiles: true})
  });
  const task = await response.json();
  if (!response.ok) throw new Error(task.error || "创建合并导出任务失败");
  const job = await waitForJob(task.jobId);
  await appendStatus(`导出完成：${(job.files || [])[0] || ""}`);
  return job;
}

async function copyRegionFiles(reportPayload, files) {
  if (!files.length) return [];
  await appendStatus(`正在整理地域 Excel 到指定文件夹：${files.length} 个。`);
  const response = await fetch(`${LOCAL_BASE}/api/copy-region-files`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      regionFolder: reportPayload.regionFolder,
      targetFolder: reportPayload.regionWorkingFolder || reportPayload.regionFolder,
      deleteSources: true,
      files
    })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "整理地域 Excel 失败");
  await appendStatus(`已整理地域 Excel：${(result.copied || []).length} 个。`);
  if ((result.deleted || []).length) {
    await appendStatus(`已清理浏览器下载目录中的地域源文件：${result.deleted.length} 个。`);
  }
  if ((result.skipped || []).length) {
    await appendStatus(`有 ${result.skipped.length} 个文件未整理，可能仍在下载或格式不符。`);
  }
  return result.copied || [];
}

async function deleteFiles(files = [], folders = []) {
  if (!files.length && !folders.length) return {deleted: [], skipped: []};
  const response = await fetch(`${LOCAL_BASE}/api/delete-files`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({files, folders})
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "清理临时文件失败");
  return result;
}

async function runVideoCombinedTask(message) {
  await storageSet({[RUNNING_KEY]: true});
  await clearCancel();
  try {
    await appendStatus(message.reportPayload?.includeArticles === false ? "准备下载视频号动态数据明细..." : "准备下载视频号动态数据明细并合并公众号数据...", true);
    const startedAfter = new Date(Date.now() - 15000).toISOString();
    await appendStatus("正在向视频号页面发送下载指令...");
    let results = await executeScriptWithTimeout({
      target: {tabId: message.tabId},
      func: clickChannelsExportButton
    });
    if (!(results || []).some(item => item?.result?.ok)) {
      await appendStatus("主页面未找到下载按钮，正在尝试页面内框架...");
      results = await executeScriptWithTimeout({
        target: {tabId: message.tabId, allFrames: true},
        func: clickChannelsExportButton
      }, 20000);
    }
    await ensureNotCancelled();
    const clicked = (results || []).find(item => item?.result?.ok);
    if (!clicked) {
      const candidateText = (results || [])
        .flatMap(item => item?.result?.candidates || [])
        .filter(Boolean)
        .slice(0, 8)
        .join("；");
      throw new Error(`没有找到视频号统计页的导出/下载按钮，请确认当前页面是数据中心的单篇数据页面。候选元素：${candidateText || "无"}`);
    }
    await appendStatus(`已点击视频号导出按钮：${clicked.result.text || "导出"}`);
    await appendStatus("正在等待浏览器完成 CSV 下载...");
    let file = await waitForChannelsCsv(startedAfter, 60000);
    if (!file) {
      const fallback = await latestChannelsCsv();
      if (fallback?.filename) {
        file = fallback.filename;
        await appendStatus(`未发现本次新下载，已改用最近 36 小时的视频号 CSV：${file}`);
      }
    }
    if (!file) throw new Error("没有监听到视频号 CSV 下载完成。");
    await appendStatus(`视频号 CSV 下载完成：${file}`);
    await runCombinedExport(message.reportPayload || {}, [file], false);
    await appendStatus("任务完成。");
  } catch (error) {
    await appendStatus(`失败：${error.message}`);
  } finally {
    await storageSet({[RUNNING_KEY]: false});
  }
}

async function runRegionTask(message) {
  await storageSet({[RUNNING_KEY]: true});
  await clearCancel();
  let copiedRegionFiles = [];
  let tempRegionFolder = "";
  try {
    if (message.action === "download" || message.action === "download-report") {
      const links = message.links || [];
      const startedAfter = new Date(Date.now() - 15000).toISOString();
      if (message.action === "download-report") {
        tempRegionFolder = `${message.reportPayload?.regionFolder || ""}\\.wechat_region_tmp_${Date.now()}`;
        if (message.reportPayload) message.reportPayload.regionWorkingFolder = tempRegionFolder;
      }
      await appendStatus(`开始下载 ${links.length} 个地域文件，间隔 3-5 秒。`, true);
      await chrome.scripting.executeScript({
        target: {tabId: message.tabId},
        func: triggerDownloadQueue,
        args: [links]
      });
      await appendStatus("地域下载已触发，正在等待 Excel 下载完成...");
      const expectedCount = Math.max(1, links.length);
      const timeoutMs = Math.max(90000, expectedCount * 7000 + 30000);
      const files = await waitForRegionExcels(startedAfter, expectedCount, timeoutMs);
      if (!files.length) throw new Error("没有监听到地域 Excel 下载完成。");
      if (files.length < expectedCount) {
        await appendStatus(`提醒：预期 ${expectedCount} 个地域文件，实际监听到 ${files.length} 个，将先用已下载文件生成。`);
      } else {
        await appendStatus(`地域 Excel 下载完成：${files.length} 个。`);
      }
      copiedRegionFiles = await copyRegionFiles(message.reportPayload || {}, files);
    }
    if (message.action === "report" || message.action === "download-report") {
      await appendStatus("开始生成地域战报...");
      const reportPayload = {...(message.reportPayload || {})};
      if (reportPayload.regionWorkingFolder) reportPayload.regionFolder = reportPayload.regionWorkingFolder;
      const response = await fetch(`${LOCAL_BASE}/api/region-report`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(reportPayload)
      });
      const task = await response.json();
      if (!response.ok) throw new Error(task.error || "创建战报任务失败");
      const job = await waitForJob(task.jobId);
      await appendStatus(`战报完成：${(job.files || [])[0] || ""}`);
      if (message.action === "download-report") {
        const cleanup = await deleteFiles(copiedRegionFiles, tempRegionFolder ? [tempRegionFolder] : []);
        await appendStatus(`已清理本次地域临时文件：${(cleanup.deleted || []).length} 项。`);
      }
    }
    await appendStatus("任务完成。");
  } catch (error) {
    await appendStatus(`失败：${error.message}`);
  } finally {
    await storageSet({[RUNNING_KEY]: false});
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "video-combined-task") {
    runVideoCombinedTask(message);
    sendResponse({ok: true});
    return false;
  }
  if (message?.type === "region-task") {
    runRegionTask(message);
    sendResponse({ok: true});
    return false;
  }
  if (message?.type === "stop-task") {
    requestCancel();
    sendResponse({ok: true});
    return false;
  }
  return false;
});
