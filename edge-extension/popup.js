const LOCAL_BASE = "http://127.0.0.1:8765";
const STATUS_KEY = "statusLog";
const RUNNING_KEY = "taskRunning";
const PATHS_KEY = "pathSettings";
const SETTINGS_KEY = "serverSettings";

const $ = (id) => document.getElementById(id);
let running = false;
let dotTimer = null;

function on(id, event, handler) {
  const element = $(id);
  if (element) element.addEventListener(event, handler);
}

async function persistStatus(text) {
  await chrome.storage.local.set({[STATUS_KEY]: text || "等待操作..."});
}

function setMessage(text, persist = true) {
  $("message").textContent = text || "等待操作...";
  $("message").scrollTop = $("message").scrollHeight;
  if (persist) persistStatus($("message").textContent);
}

function appendMessage(text, persist = true) {
  const current = $("message").textContent.trim();
  $("message").textContent = current && current !== "等待操作..." ? `${current}\n${text}` : text;
  $("message").scrollTop = $("message").scrollHeight;
  if (persist) persistStatus($("message").textContent);
}

function setRunning(value) {
  running = Boolean(value);
  if (!dotTimer) {
    dotTimer = setInterval(() => {
      const title = $("statusTitle");
      if (!title) return;
      if (!running) {
        title.textContent = "运行状态";
        return;
      }
      const dots = ".".repeat((Math.floor(Date.now() / 500) % 4));
      title.textContent = `运行状态${dots}`;
    }, 500);
  }
}

function monthStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function tokenFromUrl(url) {
  try {
    return new URL(url).searchParams.get("token") || "";
  } catch {
    return "";
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  return tab;
}

async function wechatTab() {
  const current = await activeTab();
  if (current?.url?.startsWith("https://mp.weixin.qq.com/")) return current;
  const tabs = await chrome.tabs.query({url: "https://mp.weixin.qq.com/*"});
  return tabs[0] || current;
}

async function channelsStatisticTab() {
  const current = await activeTab();
  if (current?.url?.startsWith("https://channels.weixin.qq.com/platform/statistic/post")) return current;
  const tabs = await chrome.tabs.query({url: "https://channels.weixin.qq.com/platform/statistic/post*"});
  return tabs[0] || current;
}

async function init() {
  const stored = await chrome.storage.local.get([STATUS_KEY, RUNNING_KEY, PATHS_KEY, SETTINGS_KEY]);
  if (stored[STATUS_KEY]) setMessage(stored[STATUS_KEY], false);
  setRunning(stored[RUNNING_KEY]);
  const savedPaths = stored[PATHS_KEY] || {};

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const start = formatDate(monthStart(yesterday));
  const end = formatDate(yesterday);
  $("articleStart").value = start;
  $("articleEnd").value = end;
  $("regionStart").value = start;
  $("regionEnd").value = end;
  syncReportName();

  const tab = await wechatTab();
  const token = tokenFromUrl(tab?.url || "");
  $("token").value = token;
  $("status").textContent = token ? "已识别后台 token" : "未识别 token";

  try {
    const response = await fetch(`${LOCAL_BASE}/api/status`);
    if (response.ok) {
      const data = await response.json();
      $("articleOut").value = savedPaths.articleOut || data.exportDir || "";
      $("regionFolder").value = savedPaths.regionFolder || data.regionDir || "";
      await chrome.storage.local.set({[SETTINGS_KEY]: data.settings || {}});
      if (stored[RUNNING_KEY]) {
        // 保留后台状态日志。
      } else if (data.configured && data.secretConfigured) {
        setMessage("准备就绪。");
      } else {
        setMessage("点击上方工具设置填写AppSecret");
      }
    }
  } catch {
    setMessage("本地服务未连接。请先启动本地工具。");
  }
}

function syncReportName() {
  $("reportName").value = `泰绩优地域战报_${$("regionStart").value}_${$("regionEnd").value}.xlsx`;
}

async function waitForJob(jobId) {
  while (true) {
    const response = await fetch(`${LOCAL_BASE}/api/job?id=${encodeURIComponent(jobId)}`);
    const job = await response.json();
    if (job.status === "done") return job;
    if (job.status === "error") throw new Error((job.log || []).slice(-1)[0] || "任务失败");
    await new Promise(resolve => setTimeout(resolve, 900));
  }
}

function combinedPayload(includeArticles = true) {
  return {
    start: $("articleStart").value,
    end: $("articleEnd").value,
    out: $("articleOut").value,
    includeArticles,
    outputName: includeArticles
      ? `公众号视频号合并运营表_${$("articleStart").value}_${$("articleEnd").value}.xlsx`
      : `视频号运营表_${$("articleStart").value}_${$("articleEnd").value}.xlsx`
  };
}

function reportPayload() {
  return {
    start: $("regionStart").value,
    end: $("regionEnd").value,
    out: $("articleOut").value,
    regionFolder: $("regionFolder").value,
    outputName: $("reportName").value
  };
}

async function createRegionLinks() {
  const token = $("token").value.trim();
  if (!token) throw new Error("未识别 token，请先打开公众号后台页面。");
  const response = await fetch(`${LOCAL_BASE}/api/region-links`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      start: $("regionStart").value,
      end: $("regionEnd").value,
      mpToken: token,
      downloadTemplate: $("downloadTemplate").value
    })
  });
  const task = await response.json();
  if (!response.ok) throw new Error(task.error || "创建地域下载链接失败。");
  return waitForJob(task.jobId);
}

async function startRegionTask(action) {
  try {
    if (action === "download" || action === "download-report") {
      setMessage("正在生成地域下载链接...");
      const tab = await wechatTab();
      if (!tab?.url?.startsWith("https://mp.weixin.qq.com/")) throw new Error("请先打开公众号后台页面。");
      const job = await createRegionLinks();
      const links = job.links || [];
      if (!links.length) throw new Error("没有生成可下载链接。");
      const started = await chrome.runtime.sendMessage({
        type: "region-task",
        action,
        links,
        tabId: tab.id,
        reportPayload: reportPayload()
      });
      if (!started?.ok) throw new Error("后台任务启动失败。");
      appendMessage(`已生成 ${links.length} 条下载链接，后台任务已开始。`);
      return;
    }
    setMessage("后台已开始生成地域战报...");
    const started = await chrome.runtime.sendMessage({type: "region-task", action, reportPayload: reportPayload()});
    if (!started?.ok) throw new Error("后台任务启动失败。");
  } catch (error) {
    setMessage(`失败：${error.message}`);
  }
}

async function startVideoTask(includeArticles) {
  try {
    setMessage(includeArticles ? "准备下载视频号统计表并合并导出..." : "准备下载视频号统计表...");
    const tab = await channelsStatisticTab();
    if (!tab?.url?.startsWith("https://channels.weixin.qq.com/platform/statistic/post")) {
      throw new Error("请先打开视频号数据页面：https://channels.weixin.qq.com/platform/statistic/post");
    }
    const started = await chrome.runtime.sendMessage({
      type: "video-combined-task",
      tabId: tab.id,
      reportPayload: combinedPayload(includeArticles)
    });
    if (!started?.ok) throw new Error("后台任务启动失败。");
    appendMessage("后台任务已开始。请确认视频号统计页当前日期范围与插件日期范围一致。");
  } catch (error) {
    setMessage(`失败：${error.message}`);
  }
}

async function pickFolder(inputId) {
  try {
    const response = await fetch(`${LOCAL_BASE}/api/pick-folder`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({initial: $(inputId).value})
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "选择文件夹失败。");
    if (data.path) {
      $(inputId).value = data.path;
      await savePaths();
    }
  } catch (error) {
    setMessage(error.message);
  }
}

async function savePaths() {
  await chrome.storage.local.set({
    [PATHS_KEY]: {
      articleOut: $("articleOut").value,
      regionFolder: $("regionFolder").value
    }
  });
}

async function openFolder(inputId) {
  try {
    const response = await fetch(`${LOCAL_BASE}/api/open-folder`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({out: $(inputId).value})
    });
    if (!response.ok) throw new Error("打开文件夹失败。");
    setMessage("已打开文件夹。");
  } catch (error) {
    setMessage(error.message);
  }
}

async function downloadTextFile(filename, text) {
  const blob = new Blob([text], {type: "text/plain;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({url, filename, saveAs: false, conflictAction: "uniquify"});
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function exportStatusLog() {
  const data = await chrome.storage.local.get([STATUS_KEY, RUNNING_KEY]);
  const text = [
    "公众号数据助手运行日志",
    `导出时间：${new Date().toLocaleString("zh-CN", {hour12: false})}`,
    `任务运行中：${data[RUNNING_KEY] ? "是" : "否"}`,
    `导出目录：${$("articleOut")?.value || ""}`,
    `公众号日期：${$("articleStart")?.value || ""} 至 ${$("articleEnd")?.value || ""}`,
    "",
    data[STATUS_KEY] || $("message").textContent || "无日志"
  ].join("\n");
  await downloadTextFile(`wechat_stats_log_${formatDate(new Date())}.txt`, "\uFEFF" + text);
  appendMessage("已导出运行日志。");
}

on("openSecrets", "click", async () => chrome.runtime.openOptionsPage());
on("checkLocal", "click", async () => {
  try {
    const response = await fetch(`${LOCAL_BASE}/api/status`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    setMessage("本地服务正常。");
  } catch {
    setMessage("无法连接本地服务，请先启动本地工具。");
  }
});
on("stopTask", "click", async () => {
  const started = await chrome.runtime.sendMessage({type: "stop-task"});
  appendMessage(started?.ok ? "已发送停止请求。" : "停止请求发送失败。");
});
on("exportLog", "click", exportStatusLog);
on("pickArticleFolder", "click", () => pickFolder("articleOut"));
on("pickRegionFolder", "click", () => pickFolder("regionFolder"));
on("articleOut", "change", savePaths);
on("regionFolder", "change", savePaths);
on("openArticleFolder", "click", () => openFolder("articleOut"));
on("openRegionFolder", "click", () => openFolder("regionFolder"));
on("regionStart", "change", syncReportName);
on("regionEnd", "change", syncReportName);

on("fetchArticle", "click", async () => {
  try {
    setMessage("正在获取公众号数据...");
    let settings = {};
    try {
      const response = await fetch(`${LOCAL_BASE}/api/status`);
      if (response.ok) settings = (await response.json()).settings || {};
    } catch {
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      settings = stored[SETTINGS_KEY] || {};
    }
    const response = await fetch(`${LOCAL_BASE}/api/export`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        start: $("articleStart").value,
        end: $("articleEnd").value,
        mode: settings.mode || "totaldetail",
        out: $("articleOut").value,
        rowMode: settings.rowMode || "latest",
        selectedFields: settings.selectedFields || undefined,
        forceRefreshToken: false
      })
    });
    const task = await response.json();
    if (!response.ok) throw new Error(task.error || "创建公众号数据任务失败。");
    const job = await waitForJob(task.jobId);
    setMessage(`公众号数据完成：${(job.files || [])[0] || ""}`);
  } catch (error) {
    setMessage(`失败：${error.message}`);
  }
});

on("downloadVideoOnly", "click", () => startVideoTask(false));
on("downloadVideoAndCombine", "click", () => startVideoTask(true));
on("downloadAndReport", "click", () => startRegionTask("download-report"));
on("downloadOnly", "click", () => startRegionTask("download"));
on("buildReport", "click", () => startRegionTask("report"));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STATUS_KEY]) setMessage(changes[STATUS_KEY].newValue || "等待操作...", false);
  if (area === "local" && changes[RUNNING_KEY]) setRunning(changes[RUNNING_KEY].newValue);
});

init().catch(error => setMessage(error.message));
