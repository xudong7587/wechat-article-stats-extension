const $ = (id) => document.getElementById(id);

let running = false;
let dotTimer = null;

function setMessage(text) {
  $("message").textContent = text || "等待操作...";
  $("message").scrollTop = $("message").scrollHeight;
}

function appendMessage(text) {
  const current = $("message").textContent.trim();
  $("message").textContent = current && current !== "等待操作..." ? `${current}\n${text}` : text;
  $("message").scrollTop = $("message").scrollHeight;
}

function setRunning(value) {
  running = Boolean(value);
  if (!dotTimer) {
    dotTimer = setInterval(() => {
      const title = $("statusTitle");
      if (!running) {
        title.textContent = "运行状态";
        return;
      }
      const dots = ".".repeat(Math.floor(Date.now() / 500) % 4);
      title.textContent = `运行状态${dots}`;
    }, 500);
  }
}

async function init() {
  const yesterday = yesterdayDate();
  $("start").value = formatDate(monthStart(yesterday));
  $("end").value = formatDate(yesterday);
  $("end").max = formatDate(yesterday);
  $("start").max = formatDate(yesterday);

  const settings = await loadSettings();
  if (settings.appid && settings.appsecret) {
    setMessage("准备就绪");
  } else {
    setMessage("点击上方工具设置填写 AppID / AppSecret");
  }
}

async function findChannelsStatisticTab() {
  const [active] = await chrome.tabs.query({active: true, currentWindow: true});
  if (active?.url?.startsWith("https://channels.weixin.qq.com/platform/statistic/post")) return active;
  const tabs = await chrome.tabs.query({url: "https://channels.weixin.qq.com/platform/statistic/post*"});
  return tabs[0] || null;
}

function exportChannelsCsvInPage() {
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const normalize = (value) => String(value || "").replace(/\s+/g, "").trim();
  const visible = (element) => {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const allElements = () => Array.from(document.querySelectorAll("button,a,[role='button'],span,div"));
  const labelOf = (element) => normalize([
    element.innerText,
    element.textContent,
    element.getAttribute("aria-label"),
    element.getAttribute("title")
  ].filter(Boolean).join(" "));
  const clickableParent = (element) => {
    let current = element;
    for (let i = 0; current && i < 5; i += 1) {
      const tag = current.tagName?.toLowerCase();
      if (tag === "button" || tag === "a" || current.getAttribute("role") === "button" || current.onclick) return current;
      current = current.parentElement;
    }
    return element;
  };
  const scoreElement = (element) => {
    const label = labelOf(element);
    if (!label) return 0;
    let score = 0;
    if (/导出|下载|下载数据|导出数据|明细|动态数据明细/.test(label)) score += 8;
    if (/csv|CSV|表格|Excel|excel/.test(label)) score += 4;
    if (/动态|单篇|数据明细/.test(label)) score += 3;
    if (/删除|取消|关闭|返回/.test(label)) score -= 8;
    return score;
  };
  const findBlobLink = () => {
    const links = Array.from(document.querySelectorAll("a[href]"));
    return links.find(link => {
      const href = link.href || "";
      const label = labelOf(link);
      return href.startsWith("blob:") || /csv|download|下载|导出/.test(`${href} ${label}`);
    });
  };
  const readLinkText = async (link) => {
    const href = link?.href || "";
    if (!href) return null;
    const response = await fetch(href);
    if (!response.ok) throw new Error(`视频号导出文件读取失败：HTTP ${response.status}`);
    return response.text();
  };

  return (async () => {
    try {
      const existing = findBlobLink();
      if (existing) {
        const text = await readLinkText(existing);
        if (text && text.trim()) return {ok: true, text};
      }

      const candidates = allElements()
        .filter(visible)
        .map(element => ({element, score: scoreElement(element), label: labelOf(element)}))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score);

      if (!candidates.length) {
        return {ok: false, error: "没有找到视频号统计页的导出按钮。请确认当前页面是“数据中心 - 单篇数据”页面。"};
      }

      clickableParent(candidates[0].element).click();

      const deadline = Date.now() + 18000;
      while (Date.now() < deadline) {
        const link = findBlobLink();
        if (link) {
          const text = await readLinkText(link);
          if (text && text.trim()) return {ok: true, text};
        }
        await sleep(500);
      }

      return {
        ok: false,
        error: "已点击导出按钮，但没有读取到可用的 CSV。请先在视频号页面选择日期范围，并确认页面能正常导出明细。"
      };
    } catch (error) {
      return {ok: false, error: error.message || String(error)};
    }
  })();
}

async function readVideoRows(start, end) {
  const tab = await findChannelsStatisticTab();
  if (!tab?.id) {
    throw new Error("请先打开视频号单篇数据页面：https://channels.weixin.qq.com/platform/statistic/post，并在页面里选好日期范围。");
  }

  appendMessage("正在从视频号页面自动读取动态数据明细...");
  const [result] = await chrome.scripting.executeScript({
    target: {tabId: tab.id},
    func: exportChannelsCsvInPage
  });
  const payload = result?.result;
  if (!payload?.ok) throw new Error(payload?.error || "没有读取到视频号动态数据明细。");

  const rows = normalizeVideoRows(parseCsv(payload.text), start, end);
  if (!rows.length) {
    throw new Error("视频号明细里没有匹配当前插件日期范围的数据。请确认视频号页面日期范围和插件日期范围一致。");
  }
  appendMessage(`视频号读取完成：${rows.length} 行。`);
  return rows;
}

async function fetchArticleRows(settings, start, end) {
  const days = dateRange(start, end);
  appendMessage(`公众号日期范围：${start} 到 ${end}`);

  let rows = [];
  for (const day of days) {
    appendMessage(`正在拉取公众号 ${day} ...`);
    const data = await datacube(settings, settings.mode, day);
    const dayRows = settings.mode === "totaldetail" ? flattenTotaldetail(data) : flattenLegacy(settings.mode, data);
    rows = rows.concat(dayRows);
    appendMessage(`${day} 完成：${dayRows.length} 行。`);
  }
  if (settings.mode === "totaldetail" && rows.length) {
    appendMessage("正在补充公众号发布元数据并过滤已删除文章...");
    try {
      const metadata = await fetchPublishMetadata(settings, start, end);
      if (metadata.size) {
        rows = enrichRowsWithPublishMetadata(rows, metadata);
        const deletedCount = rows.filter(row => row.is_deleted === true).length;
        if (deletedCount) {
          rows = rows.filter(row => row.is_deleted !== true);
          appendMessage(`已剔除已删除公众号文章：${deletedCount} 行。`);
        }
        appendMessage(`发布元数据补充完成：${metadata.size} 条。`);
      } else {
        appendMessage("发布元数据未返回匹配记录，继续使用统计接口数据导出。");
      }
    } catch (error) {
      appendMessage(`发布元数据补充失败，继续导出统计数据：${error.message}`);
    }
  }
  return sortRows(settings.rowMode === "daily" ? rows : latestRowsByArticle(rows));
}

async function exportRows(rows, fields, filename) {
  const finalRows = sortRows(rows);
  const csv = makeCsv(finalRows, fields);
  await downloadCsv(filename, csv);
  appendMessage(`导出完成：${filename}`);
  appendMessage(`导出行数：${finalRows.length}`);
}

async function runExport(mode) {
  setRunning(true);
  setMessage("正在读取设置...");
  try {
    const settings = await loadSettings();
    const fields = (settings.selectedFields || DEFAULT_FIELDS).filter(field => FIELD_LABELS[field]);
    if (!fields.length) throw new Error("请先在工具设置里至少选择一个导出字段。");

    const start = $("start").value;
    const end = $("end").value;
    dateRange(start, end);

    if (mode === "article") {
      const articleRows = await fetchArticleRows(settings, start, end);
      await exportRows(articleRows, fields, `wechat_articles_selected_${start}_${end}.csv`);
      return;
    }

    if (mode === "video") {
      const videoRows = await readVideoRows(start, end);
      await exportRows(videoRows, fields, `wechat_channels_selected_${start}_${end}.csv`);
      return;
    }

    appendMessage("准备一键统计全部数据...");
    const videoRows = await readVideoRows(start, end);
    const articleRows = await fetchArticleRows(settings, start, end);
    await exportRows(articleRows.concat(videoRows), fields, `wechat_articles_channels_selected_${start}_${end}.csv`);
  } catch (error) {
    setMessage(`失败：${error.message}`);
  } finally {
    setRunning(false);
  }
}

$("openSettings").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("fetchArticle").addEventListener("click", () => runExport("article"));
$("exportVideoOnly").addEventListener("click", () => runExport("video"));
$("exportAll").addEventListener("click", () => runExport("all"));

init().catch(error => setMessage(error.message));
