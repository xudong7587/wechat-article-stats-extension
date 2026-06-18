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
}

async function readVideoRows(start, end) {
  const file = $("videoCsv").files?.[0];
  if (!file) throw new Error("请先选择视频号动态数据明细 CSV。");
  const text = await file.text();
  const rows = normalizeVideoRows(parseCsv(text), start, end);
  if (!rows.length) throw new Error("视频号 CSV 中没有匹配当前日期范围的数据。");
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
      appendMessage("正在读取视频号 CSV ...");
      const videoRows = await readVideoRows(start, end);
      await exportRows(videoRows, fields, `wechat_channels_selected_${start}_${end}.csv`);
      return;
    }

    appendMessage("正在读取视频号 CSV ...");
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
