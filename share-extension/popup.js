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

async function fetchArticles() {
  setRunning(true);
  setMessage("正在读取设置...");
  try {
    const settings = await loadSettings();
    const fields = (settings.selectedFields || DEFAULT_FIELDS).filter(field => FIELD_LABELS[field]);
    if (!fields.length) throw new Error("请先在工具设置里至少选择一个导出字段。");

    const start = $("start").value;
    const end = $("end").value;
    const days = dateRange(start, end);
    appendMessage(`日期范围：${start} 到 ${end}`);

    let rows = [];
    for (const day of days) {
      appendMessage(`正在拉取 ${day} ...`);
      const data = await datacube(settings, settings.mode, day);
      const dayRows = settings.mode === "totaldetail" ? flattenTotaldetail(data) : flattenLegacy(settings.mode, data);
      rows = rows.concat(dayRows);
      appendMessage(`${day} 完成：${dayRows.length} 行。`);
    }

    const finalRows = sortRows(settings.rowMode === "daily" ? rows : latestRowsByArticle(rows));
    const csv = makeCsv(finalRows, fields);
    const filename = `wechat_articles_selected_${start}_${end}.csv`;
    await downloadCsv(filename, csv);
    appendMessage(`导出完成：${filename}`);
    appendMessage(`导出行数：${finalRows.length}`);
  } catch (error) {
    setMessage(`失败：${error.message}`);
  } finally {
    setRunning(false);
  }
}

$("openSettings").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("fetchArticle").addEventListener("click", fetchArticles);

init().catch(error => setMessage(error.message));
