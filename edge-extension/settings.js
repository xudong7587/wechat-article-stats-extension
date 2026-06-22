const $ = (id) => document.getElementById(id);

let currentOrder = [];

function setMessage(text) {
  $("message").textContent = text || "等待保存...";
}

function renderFieldPicker(order) {
  const picker = $("fieldPicker");
  picker.innerHTML = "";
  for (const [field, label] of Object.entries(FIELD_LABELS)) {
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
  currentOrder = order.filter(field => FIELD_LABELS[field]);
  const select = $("fieldOrder");
  select.innerHTML = "";
  for (const field of currentOrder) {
    const option = document.createElement("option");
    option.value = field;
    option.textContent = FIELD_LABELS[field];
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

async function init() {
  const settings = await loadSettings();
  $("appid").value = settings.appid || "";
  $("appsecret").value = settings.appsecret || "";
  $("mode").value = settings.mode || "totaldetail";
  $("rowMode").value = settings.rowMode || "latest";
  const order = (settings.selectedFields || DEFAULT_FIELDS).filter(field => FIELD_LABELS[field]);
  renderFieldPicker(order);
  renderOrder(order.length ? order : DEFAULT_FIELDS);
}

async function save() {
  const selectedFields = currentOrder.filter(field => FIELD_LABELS[field]);
  if (!selectedFields.length) {
    setMessage("请至少选择一个字段。");
    return;
  }
  await saveSettings({
    appid: $("appid").value.trim(),
    appsecret: $("appsecret").value.trim(),
    mode: $("mode").value,
    rowMode: $("rowMode").value,
    selectedFields
  });
  setMessage("设置已保存。");
}

$("moveUp").addEventListener("click", () => moveSelected(-1));
$("moveDown").addEventListener("click", () => moveSelected(1));
$("resetFields").addEventListener("click", () => {
  renderFieldPicker(DEFAULT_FIELDS);
  renderOrder(DEFAULT_FIELDS);
});
$("saveSettings").addEventListener("click", () => save().catch(error => setMessage(`保存失败：${error.message}`)));

init().catch(error => setMessage(error.message));
