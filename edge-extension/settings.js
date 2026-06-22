const LOCAL_BASE = "http://127.0.0.1:8765";
const SETTINGS_CACHE_KEY = "serverSettings";

const DEFAULT_FIELDS = [
  "title",
  "ref_date",
  "read_user",
  "like_user",
  "share_user",
  "zaikan_user",
  "comment_count",
  "source_type"
];

let fieldLabels = {};
let currentOrder = [];

const $ = (id) => document.getElementById(id);

function setMessage(text) {
  $("message").textContent = text || "等待操作...";
}

async function api(path, options) {
  const response = await fetch(`${LOCAL_BASE}${path}`, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function renderFieldPicker(order) {
  const picker = $("fieldPicker");
  picker.innerHTML = "";
  for (const [field, label] of Object.entries(fieldLabels)) {
    const item = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = field;
    input.checked = order.includes(field);
    input.addEventListener("change", syncOrderFromChecks);
    item.append(input, document.createTextNode(label));
    picker.appendChild(item);
  }
}

function renderOrder(order) {
  currentOrder = order.filter(field => fieldLabels[field]);
  const select = $("fieldOrder");
  select.innerHTML = "";
  for (const field of currentOrder) {
    const option = document.createElement("option");
    option.value = field;
    option.textContent = fieldLabels[field];
    select.appendChild(option);
  }
}

function checkedFieldsInLabelOrder() {
  return Array.from(document.querySelectorAll('#fieldPicker input[type="checkbox"]:checked')).map(input => input.value);
}

function syncOrderFromChecks() {
  const checked = new Set(checkedFieldsInLabelOrder());
  const kept = currentOrder.filter(field => checked.has(field));
  const added = checkedFieldsInLabelOrder().filter(field => !kept.includes(field));
  renderOrder([...kept, ...added]);
}

function moveSelected(delta) {
  const select = $("fieldOrder");
  const index = select.selectedIndex;
  if (index < 0) return;
  const next = index + delta;
  if (next < 0 || next >= currentOrder.length) return;
  const copy = currentOrder.slice();
  [copy[index], copy[next]] = [copy[next], copy[index]];
  renderOrder(copy);
  select.selectedIndex = next;
}

async function pickFolder() {
  const data = await api("/api/pick-folder", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({initial: $("exportDir").value})
  });
  if (data.path) $("exportDir").value = data.path;
}

async function load() {
  const status = await api("/api/status");
  fieldLabels = status.fieldLabels || {};
  $("appid").value = status.appid || "";
  $("appsecret").value = "";
  $("appsecret").placeholder = status.secretConfigured ? "已保存，如需修改请重新填写" : "请输入公众号 AppSecret";
  $("exportDir").value = status.exportDir || "";
  $("mode").value = status.settings?.mode || "totaldetail";
  $("rowMode").value = status.settings?.rowMode || "latest";
  const order = (status.settings?.selectedFields || DEFAULT_FIELDS).filter(field => fieldLabels[field]);
  renderFieldPicker(order.length ? order : DEFAULT_FIELDS);
  renderOrder(order.length ? order : DEFAULT_FIELDS);
  await chrome.storage.local.set({[SETTINGS_CACHE_KEY]: status.settings || {}});
  setMessage(status.configured ? "设置已读取，密钥已就绪。" : "请填写 AppID 和 AppSecret 后保存。");
}

async function save() {
  const selectedFields = currentOrder.filter(field => fieldLabels[field]);
  if (!selectedFields.length) {
    setMessage("请至少选择一个导出字段。");
    return;
  }
  setMessage("正在保存设置...");
  await api("/api/secrets", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      appid: $("appid").value.trim(),
      appsecret: $("appsecret").value.trim(),
      exportDir: $("exportDir").value.trim()
    })
  });
  const settingsResponse = await api("/api/settings", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      mode: $("mode").value,
      rowMode: $("rowMode").value,
      selectedFields
    })
  });
  await chrome.storage.local.set({[SETTINGS_CACHE_KEY]: settingsResponse.settings || {}});
  setMessage("设置已保存。回到插件弹窗后会按这个字段顺序导出。");
}

$("pickExportDir").addEventListener("click", () => pickFolder().catch(error => setMessage(`选择失败：${error.message}`)));
$("moveUp").addEventListener("click", () => moveSelected(-1));
$("moveDown").addEventListener("click", () => moveSelected(1));
$("resetFields").addEventListener("click", () => {
  renderFieldPicker(DEFAULT_FIELDS);
  renderOrder(DEFAULT_FIELDS);
});
$("saveAll").addEventListener("click", () => save().catch(error => setMessage(`保存失败：${error.message}`)));

load().catch(error => setMessage(`读取失败：${error.message}\n请确认本地工具已启动。`));
