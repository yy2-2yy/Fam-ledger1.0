const DB_NAME = "family-ledger-db";
const DB_VERSION = 1;
const STORE = "state";
const STATE_KEY = "ledger";

const defaultCategories = [
  ["cat-grocery", "买菜", "#2f8f63"],
  ["cat-daily", "日用品", "#4f7cac"],
  ["cat-food", "餐饮", "#d46b4a"],
  ["cat-transport", "交通", "#7b61aa"],
  ["cat-medical", "医疗", "#c34f6a"],
  ["cat-gifts", "人情", "#b5842f"],
  ["cat-utilities", "水电燃气", "#338a9e"],
  ["cat-rent", "房贷/房租", "#6f7d43"],
  ["cat-other", "其他", "#737373"],
].map(([id, name, color]) => ({ id, name, color, hidden: false }));

const state = {
  records: [],
  categories: defaultCategories,
  rules: {},
  chartRange: "week",
  recordRange: "week",
  selectedCategoryIds: new Set(),
  showTotalLine: true,
  pendingImports: [],
};

const el = {};

document.addEventListener("DOMContentLoaded", async () => {
  bindElements();
  await loadState();
  ensureDefaults();
  bindEvents();
  render();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }
});

function bindElements() {
  for (const id of [
    "rangeLabel",
    "totalSpend",
    "recordCount",
    "entryForm",
    "entryDate",
    "entryAmount",
    "entrySource",
    "entryCategory",
    "entryMerchant",
    "pasteArea",
    "parsePasteBtn",
    "pendingList",
    "recordRange",
    "recordsList",
    "showTotalLine",
    "chartCategoryFilters",
    "trendChart",
    "chartLegend",
    "categoryForm",
    "categoryName",
    "categoryColor",
    "categoryList",
    "exportJsonBtn",
    "exportJsonBtn2",
    "exportCsvBtn",
    "importJsonInput",
    "importJsonInput2",
    "clearDataBtn",
  ]) {
    el[id] = document.getElementById(id);
  }
  el.entryDate.value = todayISO();
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  document.querySelectorAll(".range-button").forEach((button) => {
    button.addEventListener("click", () => {
      state.chartRange = button.dataset.chartRange;
      document.querySelectorAll(".range-button").forEach((item) => item.classList.toggle("active", item === button));
      renderChart();
      renderSummary();
    });
  });

  el.recordRange.addEventListener("change", () => {
    state.recordRange = el.recordRange.value;
    renderRecords();
    renderSummary();
  });

  el.entryMerchant.addEventListener("input", () => {
    const ruleCategory = findRuleForMerchant(el.entryMerchant.value);
    if (ruleCategory) el.entryCategory.value = ruleCategory;
  });

  el.entryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const record = readEntryForm();
    state.records.push(record);
    rememberRule(record.merchant, record.categoryId);
    el.entryForm.reset();
    el.entryDate.value = todayISO();
    await persistAndRender();
  });

  el.parsePasteBtn.addEventListener("click", () => {
    state.pendingImports = parseBillText(el.pasteArea.value);
    renderPendingImports();
  });

  el.showTotalLine.addEventListener("change", () => {
    state.showTotalLine = el.showTotalLine.checked;
    renderChart();
  });

  el.categoryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = el.categoryName.value.trim();
    if (!name) return;
    state.categories.push({
      id: crypto.randomUUID(),
      name,
      color: el.categoryColor.value,
      hidden: false,
    });
    el.categoryForm.reset();
    el.categoryColor.value = "#4f7cac";
    await persistAndRender();
  });

  el.exportJsonBtn.addEventListener("click", exportJson);
  el.exportJsonBtn2.addEventListener("click", exportJson);
  el.exportCsvBtn.addEventListener("click", exportCsv);
  el.importJsonInput.addEventListener("change", importJson);
  el.importJsonInput2.addEventListener("change", importJson);
  el.clearDataBtn.addEventListener("click", async () => {
    if (!confirm("确定清空本地账本数据吗？请先导出备份。")) return;
    state.records = [];
    state.categories = structuredClone(defaultCategories);
    state.rules = {};
    state.selectedCategoryIds.clear();
    await persistAndRender();
  });

  window.addEventListener("resize", renderChart);
}

function switchView(view) {
  document.querySelectorAll(".tab").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  document.querySelectorAll(".view").forEach((section) => section.classList.remove("active"));
  document.getElementById(`${view}View`).classList.add("active");
  if (view === "trends") renderChart();
}

async function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadState() {
  const db = await openDB();
  const saved = await txRequest(db.transaction(STORE).objectStore(STORE).get(STATE_KEY));
  if (!saved) return;
  state.records = Array.isArray(saved.records) ? saved.records : [];
  state.categories = Array.isArray(saved.categories) ? saved.categories : defaultCategories;
  state.rules = saved.rules && typeof saved.rules === "object" ? saved.rules : {};
}

async function saveState() {
  const db = await openDB();
  await txRequest(db.transaction(STORE, "readwrite").objectStore(STORE).put({
    records: state.records,
    categories: state.categories,
    rules: state.rules,
    exportedAt: new Date().toISOString(),
  }, STATE_KEY));
}

function txRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function ensureDefaults() {
  const ids = new Set(state.categories.map((item) => item.id));
  for (const category of defaultCategories) {
    if (!ids.has(category.id)) state.categories.push(category);
  }
  if (!state.categories.some((category) => !category.hidden)) {
    state.categories[0].hidden = false;
  }
}

async function persistAndRender() {
  await saveState();
  render();
}

function render() {
  renderCategorySelect();
  renderSummary();
  renderRecords();
  renderPendingImports();
  renderCategoryFilters();
  renderCategories();
  renderChart();
}

function renderCategorySelect() {
  const activeCategories = state.categories.filter((category) => !category.hidden);
  el.entryCategory.innerHTML = activeCategories.map(optionHtml).join("");
}

function optionHtml(category) {
  return `<option value="${escapeHtml(category.id)}">${escapeHtml(category.name)}</option>`;
}

function renderSummary() {
  const records = getRecordsForRange(state.recordRange);
  el.rangeLabel.textContent = rangeName(state.recordRange);
  el.totalSpend.textContent = money(sum(records.map((record) => record.amount)));
  el.recordCount.textContent = String(records.length);
}

function renderRecords() {
  const records = getRecordsForRange(state.recordRange).sort((a, b) => b.date.localeCompare(a.date));
  if (!records.length) {
    el.recordsList.innerHTML = `<div class="empty-state">还没有记录</div>`;
    return;
  }
  el.recordsList.innerHTML = records.map((record) => {
    const category = getCategory(record.categoryId);
    return `
      <article class="record-item">
        <div class="record-main">
          <div class="record-title">${escapeHtml(record.merchant || "未填写备注")}</div>
          <div class="record-meta">
            <span>${escapeHtml(record.date)}</span>
            <span>${escapeHtml(record.source)}</span>
            <span class="chip"><span class="chip-dot" style="color:${escapeAttr(category.color)}"></span>${escapeHtml(category.name)}</span>
          </div>
        </div>
        <div>
          <div class="amount">${money(record.amount)}</div>
          <button class="delete-button" type="button" data-delete-record="${escapeAttr(record.id)}">删除</button>
        </div>
      </article>
    `;
  }).join("");
  el.recordsList.querySelectorAll("[data-delete-record]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.records = state.records.filter((record) => record.id !== button.dataset.deleteRecord);
      await persistAndRender();
    });
  });
}

function renderPendingImports() {
  if (!state.pendingImports.length) {
    el.pendingList.innerHTML = "";
    return;
  }
  el.pendingList.innerHTML = state.pendingImports.map((item, index) => `
    <div class="pending-item">
      <div class="record-main">
        <div class="record-title">${escapeHtml(item.merchant || "待确认记录")}</div>
        <div class="record-meta"><span>${escapeHtml(item.date)}</span><span>${money(item.amount)}</span><span>${escapeHtml(item.raw)}</span></div>
      </div>
      <div>
        <select data-pending-category="${index}">
          ${state.categories.filter((category) => !category.hidden).map((category) => `<option value="${escapeAttr(category.id)}" ${category.id === item.categoryId ? "selected" : ""}>${escapeHtml(category.name)}</option>`).join("")}
        </select>
        <button class="mini-button" type="button" data-add-pending="${index}">添加</button>
      </div>
    </div>
  `).join("");
  el.pendingList.querySelectorAll("[data-pending-category]").forEach((select) => {
    select.addEventListener("change", () => {
      state.pendingImports[Number(select.dataset.pendingCategory)].categoryId = select.value;
    });
  });
  el.pendingList.querySelectorAll("[data-add-pending]").forEach((button) => {
    button.addEventListener("click", async () => {
      const item = state.pendingImports[Number(button.dataset.addPending)];
      const record = { ...item, id: crypto.randomUUID(), source: item.source || "导入" };
      delete record.raw;
      state.records.push(record);
      rememberRule(record.merchant, record.categoryId);
      state.pendingImports.splice(Number(button.dataset.addPending), 1);
      await persistAndRender();
    });
  });
}

function renderCategoryFilters() {
  el.chartCategoryFilters.innerHTML = state.categories.map((category) => `
    <label class="checkbox-pill">
      <input type="checkbox" value="${escapeAttr(category.id)}" ${state.selectedCategoryIds.has(category.id) ? "checked" : ""} />
      <span class="chip-dot" style="color:${escapeAttr(category.color)}"></span>
      ${escapeHtml(category.name)}
    </label>
  `).join("");
  el.chartCategoryFilters.querySelectorAll("input").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) state.selectedCategoryIds.add(input.value);
      else state.selectedCategoryIds.delete(input.value);
      renderChart();
    });
  });
}

function renderCategories() {
  el.categoryList.innerHTML = state.categories.map((category) => `
    <div class="category-item">
      <span class="category-color" style="background:${escapeAttr(category.color)}"></span>
      <div class="category-edit">
        <input value="${escapeAttr(category.name)}" data-category-name="${escapeAttr(category.id)}" aria-label="分类名称" />
        <input type="color" value="${escapeAttr(category.color)}" data-category-color="${escapeAttr(category.id)}" aria-label="分类颜色" />
        <label class="checkbox-pill">
          <input type="checkbox" data-category-hidden="${escapeAttr(category.id)}" ${category.hidden ? "checked" : ""} />
          隐藏
        </label>
        <button class="mini-button" type="button" data-save-category="${escapeAttr(category.id)}">保存</button>
      </div>
      <button class="delete-button" type="button" data-delete-category="${escapeAttr(category.id)}">删除</button>
    </div>
  `).join("");
  el.categoryList.querySelectorAll("[data-save-category]").forEach((button) => {
    button.addEventListener("click", async () => {
      const category = getCategory(button.dataset.saveCategory);
      category.name = el.categoryList.querySelector(`[data-category-name="${CSS.escape(category.id)}"]`).value.trim() || category.name;
      category.color = el.categoryList.querySelector(`[data-category-color="${CSS.escape(category.id)}"]`).value;
      category.hidden = el.categoryList.querySelector(`[data-category-hidden="${CSS.escape(category.id)}"]`).checked;
      if (state.categories.every((item) => item.hidden)) category.hidden = false;
      await persistAndRender();
    });
  });
  el.categoryList.querySelectorAll("[data-delete-category]").forEach((button) => {
    button.addEventListener("click", async () => {
      const used = state.records.some((record) => record.categoryId === button.dataset.deleteCategory);
      if (used) {
        alert("这个分类已有记录，建议改名或隐藏，不能删除。");
        return;
      }
      state.categories = state.categories.filter((category) => category.id !== button.dataset.deleteCategory);
      await persistAndRender();
    });
  });
}

function renderChart() {
  if (!el.trendChart) return;
  const canvas = el.trendChart;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(680, Math.floor(rect.width * dpr));
  canvas.height = Math.floor((rect.width < 520 ? 330 : 420) * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;
  const pad = { top: 24, right: 18, bottom: 42, left: 48 };
  ctx.clearRect(0, 0, width, height);

  const dates = getDateRange(state.chartRange);
  const records = state.records.filter((record) => dates.includes(record.date));
  const series = [];
  if (state.showTotalLine) {
    series.push({ name: "总消费", color: "#111827", values: dates.map((date) => sum(records.filter((record) => record.date === date).map((record) => record.amount))) });
  }
  for (const categoryId of state.selectedCategoryIds) {
    const category = getCategory(categoryId);
    series.push({
      name: category.name,
      color: category.color,
      values: dates.map((date) => sum(records.filter((record) => record.date === date && record.categoryId === categoryId).map((record) => record.amount))),
    });
  }

  const maxValue = Math.max(10, ...series.flatMap((line) => line.values));
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  drawAxes(ctx, width, height, pad, dates, maxValue);
  if (!series.length) {
    ctx.fillStyle = "#6b7280";
    ctx.font = "13px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("请选择总消费或至少一个分类", width / 2, height / 2);
  }
  series.forEach((line) => drawLine(ctx, line, dates, maxValue, pad, plotW, plotH));
  renderLegend(series);
}

function drawAxes(ctx, width, height, pad, dates, maxValue) {
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  ctx.fillStyle = "#6b7280";
  ctx.font = "12px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const value = (maxValue / 4) * i;
    const y = pad.top + plotH - (plotH * i) / 4;
    ctx.fillText(Math.round(value).toString(), pad.left - 8, y + 4);
    ctx.strokeStyle = i === 0 ? "#d7dce5" : "#edf1f7";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
  }

  const step = dates.length > 12 ? Math.ceil(dates.length / 6) : 1;
  ctx.textAlign = "center";
  dates.forEach((date, index) => {
    if (index % step !== 0 && index !== dates.length - 1) return;
    const x = pad.left + (plotW * index) / Math.max(1, dates.length - 1);
    ctx.fillText(date.slice(5), x, height - 16);
  });
}

function drawLine(ctx, line, dates, maxValue, pad, plotW, plotH) {
  const points = line.values.map((value, index) => ({
    x: pad.left + (plotW * index) / Math.max(1, dates.length - 1),
    y: pad.top + plotH - (plotH * value) / maxValue,
  }));

  ctx.strokeStyle = line.color;
  ctx.lineWidth = 2.6;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) {
      ctx.moveTo(point.x, point.y);
      return;
    }
    const previous = points[index - 1];
    const midX = (previous.x + point.x) / 2;
    ctx.bezierCurveTo(midX, previous.y, midX, point.y, point.x, point.y);
  });
  ctx.stroke();

  points.forEach((point) => {
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = line.color;
    ctx.lineWidth = 2;
    ctx.stroke();
  });
}

function renderLegend(series) {
  el.chartLegend.innerHTML = series.map((line) => `<span class="chip"><span class="chip-dot" style="color:${escapeAttr(line.color)}"></span>${escapeHtml(line.name)}</span>`).join("");
}

function readEntryForm() {
  return {
    id: crypto.randomUUID(),
    date: el.entryDate.value,
    amount: Number(el.entryAmount.value),
    source: el.entrySource.value,
    merchant: el.entryMerchant.value.trim(),
    categoryId: el.entryCategory.value,
    createdAt: new Date().toISOString(),
  };
}

function parseBillText(text) {
  const fallbackCategory = state.categories.find((category) => !category.hidden)?.id || state.categories[0].id;
  return text.split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const dateMatch = line.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
      const amountMatch = line.match(/(?:¥|￥)?\s*(-?\d+(?:\.\d{1,2})?)/g);
      const amount = amountMatch ? Math.abs(Number(amountMatch.at(-1).replace(/[¥￥\s]/g, ""))) : 0;
      const date = dateMatch ? `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}` : todayISO();
      const merchant = line
        .replace(dateMatch?.[0] || "", "")
        .replace(amountMatch?.at(-1) || "", "")
        .replace(/[,\t|，]/g, " ")
        .trim();
      return {
        date,
        amount,
        merchant,
        source: line.includes("微信") ? "微信" : line.includes("支付宝") ? "支付宝" : "导入",
        categoryId: findRuleForMerchant(merchant) || fallbackCategory,
        raw: line,
      };
    })
    .filter((item) => item.amount > 0);
}

function rememberRule(merchant, categoryId) {
  const key = normalizeMerchant(merchant);
  if (key) state.rules[key] = categoryId;
}

function findRuleForMerchant(merchant) {
  return state.rules[normalizeMerchant(merchant)];
}

function normalizeMerchant(merchant) {
  return String(merchant || "").trim().toLowerCase().slice(0, 40);
}

function getRecordsForRange(range) {
  if (range === "all") return [...state.records];
  const dates = getDateRange(range);
  return state.records.filter((record) => dates.includes(record.date));
}

function getDateRange(range) {
  const now = new Date();
  const start = range === "month" ? new Date(now.getFullYear(), now.getMonth(), 1) : startOfWeek(now);
  const end = range === "month" ? new Date(now.getFullYear(), now.getMonth() + 1, 0) : addDays(start, 6);
  const dates = [];
  for (let day = new Date(start); day <= end; day = addDays(day, 1)) dates.push(toISO(day));
  return dates;
}

function startOfWeek(date) {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = copy.getDay() || 7;
  copy.setDate(copy.getDate() - day + 1);
  return copy;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function todayISO() {
  return toISO(new Date());
}

function toISO(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getCategory(id) {
  return state.categories.find((category) => category.id === id) || state.categories.find((category) => category.id === "cat-other") || defaultCategories.at(-1);
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function money(value) {
  return `¥${Number(value || 0).toFixed(2)}`;
}

function rangeName(range) {
  return range === "month" ? "本月" : range === "all" ? "全部" : "本周";
}

function exportJson() {
  download("family-ledger-backup.json", JSON.stringify({
    records: state.records,
    categories: state.categories,
    rules: state.rules,
    exportedAt: new Date().toISOString(),
  }, null, 2), "application/json");
}

function exportCsv() {
  const rows = [["日期", "金额", "来源", "商户/备注", "分类"]];
  for (const record of state.records) {
    rows.push([record.date, record.amount, record.source, record.merchant, getCategory(record.categoryId).name]);
  }
  download("family-ledger-records.csv", rows.map((row) => row.map(csvCell).join(",")).join("\n"), "text/csv;charset=utf-8");
}

async function importJson(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data.records) || !Array.isArray(data.categories)) throw new Error("Invalid backup");
    state.records = data.records;
    state.categories = data.categories;
    state.rules = data.rules || {};
    state.selectedCategoryIds.clear();
    ensureDefaults();
    await persistAndRender();
  } catch {
    alert("备份文件无法识别。");
  } finally {
    event.target.value = "";
  }
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value);
}
