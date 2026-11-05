// ============================================================================
// Bog'chaOS: Enterprise Pro Dashboard Logic
// Barcha 7 ta modul: Rollar, Davomat, Tabel, Omborxona, To'garaklar, Maosh, Shartnomalar
// ============================================================================

// The e2e suite points this at an isolated test backend via window.__BOGCHA_API_BASE__;
// Local dev (frontend on :4321) talks to the API on :8000; when deployed, the
// backend serves this page too, so the API is on the same origin.
const API_BASE = window.__BOGCHA_API_BASE__ ||
  (location.port === '4321' || location.protocol === 'file:' ? 'http://127.0.0.1:8000/api/v1' : '/api/v1');

const STATE = {
  theme: 'light',
  currentRole: null,
  permissions: new Set(),
  currentTab: 'dashboard',
  groups: [],
  children: [],
  activities: [],
  staffPayroll: [],
  payrollMeta: null,
  tabelData: null,
  financeStats: null,
  auditLog: []
};

// ============================================================================
// Initialization & Backend Sync
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
  applyTranslations(document);
  initLang();
  initTheme();
  initNavigation();
  initMobileNav();
  initAttendance();
  initLiveClock();
  initPhotos();
  initReminders();
  initStaffAttendance();
  initKitchen();
  initUserSession().then(ok => {
    if (!ok) return;
    syncWithBackend();
    if (can('photos.send')) loadPhotoStatus();
    if (can('billing.remind')) loadReminders();
    if (can('staff.view')) loadStaffAttendance();
    if (can('kitchen.view')) loadKitchenReports();
  });

  // Search Listeners
  const searchInput = document.getElementById('globalSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => handleGlobalSearch(e.target.value));
  }
  const childFilterInput = document.getElementById('childSearchFilter');
  if (childFilterInput) {
    childFilterInput.addEventListener('input', renderChildrenTable);
  }
  const childStatusSelect = document.getElementById('childStatusFilter');
  if (childStatusSelect) {
    childStatusSelect.addEventListener('change', renderChildrenTable);
  }
});

async function syncWithBackend() {
  try {
    // Only request what this role may see; the server enforces the same rules.
    const get = (perm, path) => can(perm) ? apiFetch(`${API_BASE}${path}`).catch(() => null) : Promise.resolve(null);
    const [statsRes, groupsRes, childrenRes, staffRes, financeStatsRes, attTodayRes] = await Promise.all([
      get('dashboard.view', '/dashboard/stats'),
      get('children.view', '/groups'),
      get('children.view', '/children'),
      get('staff.view', `/staff/payroll?month=${staffMonth()}`),
      get('billing.view', '/billing/stats'),
      get('attendance.view', '/attendance?group_name=ALL'),
    ]);
    if (attTodayRes?.ok) {
      STATE.attToday = Object.fromEntries((await attTodayRes.json()).map(r => [r.child_id, r.status]));
    }

    if (statsRes?.ok) {
      STATE.dashboard = await statsRes.json();
      STATE.activities = STATE.dashboard.activities || [];
    }

    if (groupsRes?.ok) STATE.groups = await groupsRes.json();
    if (childrenRes?.ok) {
      STATE.children = await childrenRes.json();
      const badge = document.getElementById('totalChildrenBadge');
      if (badge) badge.innerText = STATE.children.length;
    }
    if (staffRes?.ok) setPayrollData(await staffRes.json());
    if (financeStatsRes?.ok) STATE.financeStats = await financeStatsRes.json();

    // Re-render UI
    renderActivities();
    renderGroupsMiniGrid();
    renderDashboard();
    renderGroupFilterTabs();
    populateSelectOptions();
    renderChildrenTable();
    loadAttendance();
    loadTabel();
    renderInvoicesTable();
    renderFinanceStats();
    renderStaffPayroll();
    if (can('staff.view')) loadStaffSheet();
    if (can('settings.view')) loadPayrollRules();
    if (can('finance.reports')) loadReports();
    renderContractsTable();
    updateTmaSimulator();
    if (can('audit.view')) loadAuditLog();

    console.log("[Bog'chaOS] Barcha 7 ta modul ma'lumotlar bazasi bilan sinxronlandi!");
  } catch (err) {
    console.warn("[Bog'chaOS] Backend sinxronlashda xatolik:", err);
  }
}

// ============================================================================
// 1. Role-Based Access Control (Rollar Boshqaruvi)
// ============================================================================

function roleTitle(role) {
  return t(`role.${role}`);
}

// Permissions come from the server (/auth/me), which also enforces them on every request.
// Hiding things here is only a convenience; it is not what protects the data.
function can(permission) {
  return STATE.permissions.has(permission);
}

function apiFetch(url, options = {}) {
  let token = null;
  try { token = localStorage.getItem('bogcha_token'); } catch (e) {}
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { ...options, headers }).then(res => {
    if (res.status === 401) {
      try { localStorage.removeItem('bogcha_user'); localStorage.removeItem('bogcha_token'); } catch (e) {}
      window.location.href = `login.html?t=${Date.now()}`;
    }
    return res;
  });
}

function applyRoleAccess(role) {
  STATE.currentRole = role;

  const title = roleTitle(role);
  document.getElementById('currentUserRole').innerText = title;
  const badge = document.getElementById('currentRoleBadge');
  if (badge) badge.innerText = title;

  document.querySelectorAll('.sidebar-nav .nav-item').forEach(btn => {
    btn.style.display = can(btn.getAttribute('data-perm')) ? 'flex' : 'none';
  });

  const activeTabBtn = document.querySelector(`.sidebar-nav .nav-item[data-tab="${STATE.currentTab}"]`);
  if (activeTabBtn && activeTabBtn.style.display === 'none') {
    const firstVisible = document.querySelector('.sidebar-nav .nav-item:not([style*="display: none"])');
    if (firstVisible) {
      switchTab(firstVisible.getAttribute('data-tab'));
    }
  }

  const showFinance = can('children.finance');
  document.querySelectorAll('[data-perm-col="children.finance"]').forEach(th => { th.style.display = showFinance ? '' : 'none'; });

  const thDelete = document.getElementById('thDelete');
  if (thDelete) thDelete.style.display = can('children.delete') ? '' : 'none';

  document.querySelectorAll('[data-perm-action]').forEach(el => {
    el.style.display = can(el.getAttribute('data-perm-action')) ? '' : 'none';
  });

  renderChildrenTable();
}

async function initUserSession() {
  let token = null;
  try { token = localStorage.getItem('bogcha_token'); } catch (e) {}
  if (!token) {
    window.location.href = `login.html?t=${Date.now()}`;
    return false;
  }
  try {
    const res = await apiFetch(`${API_BASE}/auth/me`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const user = await res.json();
    STATE.permissions = new Set(user.permissions);
    applyRoleAccess(user.role);
    document.getElementById('currentUserName').innerText = user.name;
    document.getElementById('currentUserAvatar').innerText = user.avatar || user.name.split(' ').map(n => n[0]).join('');
    const greet = document.getElementById('dashboardGreeting');
    if (greet) greet.innerText = t('dash.greeting', { name: user.name });
    if (user.org) {
      STATE.org = user.org;
      const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
      setText('tenantAvatar', user.org.avatar);
      setText('tenantName', user.org.name);
      setText('tenantPlan', `${user.org.plan_tier} ${t('settings.tarif')}`);
      setText('contractOrgName', user.org.name.toUpperCase());
      setText('contractOrgName2', user.org.name);
      setText('receiptOrgName', user.org.name.toUpperCase());
      setText('tmaAppTitle', `${user.org.name} TMA`);
      const orgName = document.getElementById('settingsOrgName');
      if (orgName) orgName.value = user.org.name;
      const orgPhone = document.getElementById('settingsOrgPhone');
      if (orgPhone) orgPhone.value = user.org.phone || '';
      const orgAddress = document.getElementById('settingsOrgAddress');
      if (orgAddress) orgAddress.value = user.org.address || '';
    }
    return true;
  } catch (e) {
    showToast(t('toast.sessionExpired'), 'warning');
    return false;
  }
}

function logoutUser() {
  try { localStorage.removeItem('bogcha_user'); localStorage.removeItem('bogcha_token'); } catch (e) {}
  showToast(t('toast.loggedOut'), "info");
  setTimeout(() => {
    window.location.href = `login.html?t=${Date.now()}`;
  }, 400);
}

// ============================================================================
// 2. Oylik Tabel (Monthly Attendance Matrix & Compensation)
// ============================================================================

const TABEL_STATUS_CELL = { PRESENT: 'p-cell', EXCUSED: 'e-cell', ABSENT: 'a-cell', LATE: 'l-cell' };
const tabelCell = status => status
  ? `<span class="tabel-day-cell ${TABEL_STATUS_CELL[status] || ''}" title="${attStatusMeta(status).label}">${attMarkSvg(status)}</span>`
  : '';
let tabelYearsLoaded = false;
let tabelRequestSeq = 0;

async function populateTabelPeriodSelects() {
  const yearSel = document.getElementById('tabelYearSelect');
  const monthSel = document.getElementById('tabelMonthSelect');
  const groupSel = document.getElementById('tabelGroupSelect');
  if (!yearSel || !monthSel) return;
  const now = new Date();

  if (!tabelYearsLoaded) {
    let years = [now.getFullYear()];
    try {
      const res = await apiFetch(`${API_BASE}/tabel/years`);
      if (res.ok) years = await res.json();
    } catch (_) { /* fall back to the current year */ }
    yearSel.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
    yearSel.value = String(now.getFullYear());
    tabelYearsLoaded = true;
  }

  const prevMonth = monthSel.value || String(now.getMonth() + 1);
  monthSel.innerHTML = `<option value="ALL">${t('tabel.wholeYear')}</option>` +
    Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${t('month.' + (i + 1))}</option>`).join('');
  monthSel.value = prevMonth;

  if (groupSel) {
    const prevGroup = groupSel.value || 'ALL';
    groupSel.innerHTML = `<option value="ALL">${t('common.all')}</option>` +
      STATE.groups.map(g => `<option value="${escapeHtml(g.name)}">${escapeHtml(g.name)}</option>`).join('');
    groupSel.value = [...groupSel.options].some(o => o.value === prevGroup) ? prevGroup : 'ALL';
  }
}

function shiftTabelMonth(delta) {
  const yearSel = document.getElementById('tabelYearSelect');
  const monthSel = document.getElementById('tabelMonthSelect');
  if (!yearSel || !monthSel) return;
  let year = Number(yearSel.value);
  if (monthSel.value === 'ALL') {
    year += delta;
  } else {
    let month = Number(monthSel.value) + delta;
    if (month < 1) { month = 12; year -= 1; }
    if (month > 12) { month = 1; year += 1; }
    monthSel.value = String(month);
  }
  if (![...yearSel.options].some(o => o.value === String(year))) {
    const opts = [...yearSel.options].map(o => Number(o.value)).concat(year).sort((a, b) => b - a);
    yearSel.innerHTML = opts.map(y => `<option value="${y}">${y}</option>`).join('');
  }
  yearSel.value = String(year);
  loadTabel();
}

async function loadTabel() {
  if (!can('tabel.view')) return;
  await populateTabelPeriodSelects();
  const year = document.getElementById('tabelYearSelect')?.value;
  const month = document.getElementById('tabelMonthSelect')?.value;
  const group = encodeURIComponent(document.getElementById('tabelGroupSelect')?.value || 'ALL');
  const seq = ++tabelRequestSeq;
  const url = month === 'ALL'
    ? `${API_BASE}/tabel/year?year=${year}&group_name=${group}`
    : `${API_BASE}/tabel?year=${year}&month=${month}&group_name=${group}`;
  try {
    const res = await apiFetch(url);
    if (seq !== tabelRequestSeq) return;
    if (!res.ok) throw new Error(res.status);
    STATE.tabelData = await res.json();
  } catch (_) {
    if (seq !== tabelRequestSeq) return;
    STATE.tabelData = null;
    showToast(t('tabel.loadError'), 'error');
  }
  renderTabelGrid();
}

function renderTabelGrid() {
  const header = document.getElementById('tabelHeaderRow');
  const tbody = document.getElementById('tabelBodyRows');
  if (!header || !tbody) return;
  const data = STATE.tabelData;
  const label = document.getElementById('tabelPeriodLabel');

  if (data && data.month === undefined && data.rows) return renderTabelYear(data, header, tbody, label);

  const now = new Date();
  const year = data?.year ?? now.getFullYear();
  const monthIdx = (data?.month ?? now.getMonth() + 1) - 1;
  const daysInMonth = data?.days_in_month ?? new Date(year, monthIdx + 1, 0).getDate();
  const isCurrentMonth = now.getFullYear() === year && now.getMonth() === monthIdx;
  const todayNum = isCurrentMonth ? now.getDate() : null;
  const isFuture = d => new Date(year, monthIdx, d) > now;
  const isWeekend = d => [0, 6].includes(new Date(year, monthIdx, d).getDay());
  if (label) label.textContent = `${t('month.' + (monthIdx + 1))} ${year}`;

  let headerHtml = `<tr><th>${t('tabel.col.child')}</th>`;
  for (let d = 1; d <= daysInMonth; d++) {
    headerHtml += `<th class="${isWeekend(d) ? 'is-weekend' : ''}${d === todayNum ? ' is-today' : ''}">${d}</th>`;
  }
  headerHtml += `<th>${t('tabel.col.present')}</th><th>${t('tabel.col.excused')}</th><th>${t('tabel.col.absent')}</th><th>${t('tabel.col.compensation')}</th></tr>`;
  header.innerHTML = headerHtml;

  const rows = data?.rows || [];
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="${daysInMonth + 5}" class="audit-empty">${t('tabel.empty')}</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(row => {
    const days = row.days || {};
    let daysCells = '';
    for (let d = 1; d <= daysInMonth; d++) {
      const status = days[String(d)] || null;
      const todayCls = d === todayNum ? 'is-today' : '';
      if (!status && isWeekend(d)) { daysCells += `<td class="is-weekend"><span class="tabel-day-cell w-cell" title="${t('tabel.legend.weekend')}">–</span></td>`; continue; }
      if (!status && isFuture(d)) { daysCells += `<td class="${todayCls}"></td>`; continue; }
      daysCells += `<td class="${isWeekend(d) ? 'is-weekend ' : ''}${todayCls}">${tabelCell(status)}</td>`;
    }
    return `
      <tr>
        <td><b>${escapeHtml(row.name)}</b></td>
        ${daysCells}
        <td><b class="text-emerald">${row.days_present} ${t('common.days')}</b></td>
        <td><b class="text-amber">${row.days_excused} ${t('common.days')}</b></td>
        <td><b class="text-rose">${row.days_absent} ${t('common.days')}</b></td>
        <td>${tabelCompensation(row.compensation)}</td>
      </tr>
    `;
  }).join('');
}

function tabelCompensation(amount) {
  return amount > 0
    ? `<strong class="text-rose">${signedMoney(-amount)}</strong>`
    : `<span style="color: var(--text-muted);">${formatMoney(0)}</span>`;
}

function renderTabelYear(data, header, tbody, label) {
  if (label) label.textContent = `${data.year} — ${t('tabel.wholeYear')}`;
  let headerHtml = `<tr><th>${t('tabel.col.child')}</th>`;
  for (let m = 1; m <= 12; m++) headerHtml += `<th title="${t('month.' + m)}">${t('month.' + m).slice(0, 3)}</th>`;
  headerHtml += `<th>${t('tabel.col.present')}</th><th>${t('tabel.col.excused')}</th><th>${t('tabel.col.absent')}</th><th>${t('tabel.col.compensation')}</th></tr>`;
  header.innerHTML = headerHtml;

  if (!data.rows.length) {
    tbody.innerHTML = `<tr><td colspan="17" class="audit-empty">${t('tabel.empty')}</td></tr>`;
    return;
  }

  tbody.innerHTML = data.rows.map(row => {
    let cells = '';
    for (let m = 1; m <= 12; m++) {
      const s = row.months[String(m)];
      const tip = s ? `${t('month.' + m)}: ${t('tabel.col.present')} ${s.days_present}, ${t('tabel.col.excused')} ${s.days_excused}, ${t('tabel.col.absent')} ${s.days_absent}` : '';
      cells += s
        ? `<td class="tabel-year-cell"><button type="button" class="tabel-year-link" onclick="openTabelMonth(${m})" title="${tip}"><b class="text-emerald">${s.days_present}</b>${s.days_excused ? `<span class="text-amber">/${s.days_excused}</span>` : ''}${s.days_absent ? `<span class="text-rose">/${s.days_absent}</span>` : ''}</button></td>`
        : '<td class="text-muted">–</td>';
    }
    const tot = row.totals;
    return `
      <tr>
        <td><b>${escapeHtml(row.name)}</b></td>
        ${cells}
        <td><b class="text-emerald">${tot.days_present} ${t('common.days')}</b></td>
        <td><b class="text-amber">${tot.days_excused} ${t('common.days')}</b></td>
        <td><b class="text-rose">${tot.days_absent} ${t('common.days')}</b></td>
        <td>${tabelCompensation(tot.compensation)}</td>
      </tr>
    `;
  }).join('');
}

function openTabelMonth(month) {
  const monthSel = document.getElementById('tabelMonthSelect');
  if (!monthSel) return;
  monthSel.value = String(month);
  loadTabel();
}

function applyCompensationToInvoices() {
  showToast(t('tabel.approved'), 'success');
}

function exportTabelExcel() {
  showToast(t('tabel.exported'), 'info');
}

// ============================================================================
// 5. Xodimlar va Ish Haqi (Staff & Payroll)
// ============================================================================

function staffMonth() {
  const input = document.getElementById('staffMonthInput');
  if (input && !input.value) input.value = todayISO().slice(0, 7);
  return input?.value || todayISO().slice(0, 7);
}

function setPayrollData(data) {
  STATE.staffPayroll = data.rows || [];
  STATE.payrollMeta = { month: data.month, working_days: data.working_days };
}

async function reloadPayroll() {
  if (!can('staff.view')) return;
  try {
    const res = await apiFetch(`${API_BASE}/staff/payroll?month=${staffMonth()}`);
    if (res.ok) setPayrollData(await res.json());
  } catch (_) { /* table keeps the last good data */ }
  renderStaffPayroll();
}

function renderStaffRulesSummary() {
  const el = document.getElementById('staffRulesSummary');
  const meta = STATE.payrollMeta;
  if (!el || !meta) return;
  el.textContent = t('staff.rulesSummary', { days: meta.working_days });
}

// Deduction is typed in by the accountant; attendance is shown next to it only as a hint.
function staffDeductionCell(p) {
  const amount = p.deduction || 0;
  const hints = [];
  if (p.absent_days) hints.push(t('staff.deduct.absent', { n: p.absent_days }));
  if (p.late_days) hints.push(t('staff.deduct.late', { n: p.late_days }));
  const note = p.deduction_note ? `<br><small class="deduction-note">${escapeHtml(p.deduction_note)}</small>` : '';
  const hint = hints.length ? `<br><small class="text-muted" title="${t('staff.deduct.hintTitle')}">${hints.join(' · ')}</small>` : '';
  const edit = p.status !== 'PAID' && can('staff.pay')
    ? ` <button type="button" class="btn btn-sm btn-secondary deduction-edit" onclick="openDeductionModal('${escapeHtml(p.id)}')" aria-label="${t('staff.deductionModal.title')}" title="${t('staff.deductionModal.title')}">${PENCIL_ICON}</button>`
    : '';
  return `<td><span class="${amount ? 'text-rose' : ''}">${signedMoney(-amount)}</span>${edit}${note}${hint}</td>`;
}

function openDeductionModal(payrollId) {
  const p = STATE.staffPayroll.find(x => x.id === payrollId);
  if (!p) return;
  STATE.deductionPayrollId = payrollId;
  document.getElementById('deductionModalTitle').textContent = t('staff.deductionModal.titleNamed', { name: p.staff_name });
  const hints = [];
  if (p.absent_days) hints.push(t('staff.deduct.absent', { n: p.absent_days }));
  if (p.late_days) hints.push(t('staff.deduct.late', { n: p.late_days }));
  document.getElementById('deductionHint').textContent = t('staff.deductionModal.hint', {
    salary: formatMoney(p.base_salary),
    attendance: hints.length ? hints.join(', ') : t('staff.deductionModal.noAbsence'),
  });
  const amount = document.getElementById('deductionAmount');
  amount.max = p.base_salary + (p.bonus || 0);
  amount.value = p.deduction || 0;
  document.getElementById('deductionNote').value = p.deduction_note || '';
  amount.oninput = () => updateDeductionResult(p);
  updateDeductionResult(p);
  openModal('deductionModal');
  setTimeout(() => amount.select(), 50);
}

function updateDeductionResult(p) {
  const amount = parseFloat(document.getElementById('deductionAmount').value) || 0;
  const toPay = Math.max(0, p.base_salary + (p.bonus || 0) - (p.advance_paid || 0) - amount);
  document.getElementById('deductionResult').textContent = t('staff.deductionModal.result', { amount: formatMoney(toPay) });
}

async function saveDeduction(e) {
  e.preventDefault();
  const id = STATE.deductionPayrollId;
  const submit = document.getElementById('deductionSubmit');
  submit.disabled = true;
  try {
    const res = await apiFetch(`${API_BASE}/staff/payroll/${encodeURIComponent(id)}/deduction`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: parseFloat(document.getElementById('deductionAmount').value) || 0,
        note: document.getElementById('deductionNote').value.trim() || null,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : t('toast.genericError'));
    closeModal('deductionModal');
    showToast(t('staff.deductionModal.saved'), 'success');
    await reloadPayroll();
  } catch (err) {
    showToast(err.message || t('toast.genericError'), 'warning');
  } finally {
    submit.disabled = false;
  }
}

function renderStaffPayroll() {
  const tbody = document.getElementById('staffPayrollTableBody');
  if (!tbody) return;
  renderStaffRulesSummary();

  const list = STATE.staffPayroll;
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="text-muted">${t('staff.empty')}</td></tr>`;
    return;
  }
  const canManage = can('staff.manage');

  tbody.innerHTML = list.map(p => {
    const toPay = p.status === 'PAID' ? p.final_paid : p.total_to_pay;
    return `
      <tr>
        <td>
          <b>${escapeHtml(p.staff_name)}</b><br>
          <span class="badge badge-indigo">${escapeHtml(p.role)}</span>
        </td>
        <td>${escapeHtml(p.phone)}</td>
        <td>${formatMoney(p.base_salary)}</td>
        <td class="${p.bonus ? 'text-emerald' : ''}">${signedMoney(p.bonus)}</td>
        <td class="${p.advance_paid ? 'text-rose' : ''}">${signedMoney(-p.advance_paid)}</td>
        ${staffDeductionCell(p)}
        <td><b style="font-size: 1rem;">${formatMoney(toPay)}</b></td>
        <td>
          ${p.status === 'PAID'
            ? `<span class="badge badge-emerald">${t('status.paid')}</span>`
            : `<span class="badge badge-amber">${t('status.pending')}</span>`}
        </td>
        <td class="text-right">
          ${p.status === 'PAID'
            ? `<button class="btn btn-sm btn-secondary" disabled>${t('staff.paid')}</button>`
            : `<button class="btn btn-sm btn-success" onclick="payStaffSalary('${p.id}', ${toPay})">${t('staff.payBtn')}</button>`}
          ${canManage ? `<button class="btn btn-sm btn-danger staff-delete-btn" onclick="deleteStaff('${escapeHtml(p.staff_id)}')" title="${t('common.delete')}">${t('common.delete')}</button>` : ''}
        </td>
      </tr>
    `;
  }).join('');
}

// Staff monthly attendance sheet
const STAFF_SHEET = { data: null, seq: 0 };

async function loadStaffSheet() {
  const seq = ++STAFF_SHEET.seq;
  try {
    const res = await apiFetch(`${API_BASE}/staff/attendance/month?month=${staffMonth()}`);
    if (seq !== STAFF_SHEET.seq) return;
    STAFF_SHEET.data = res.ok ? await res.json() : null;
  } catch (_) {
    if (seq !== STAFF_SHEET.seq) return;
    STAFF_SHEET.data = null;
  }
  renderStaffSheet();
}

function renderStaffSheet() {
  const head = document.getElementById('staffSheetHead');
  const body = document.getElementById('staffSheetBody');
  const data = STAFF_SHEET.data;
  if (!head || !body) return;
  if (!data) { head.innerHTML = ''; body.innerHTML = `<tr><td class="text-muted">${t('att.loadError')}</td></tr>`; return; }

  const [year, month] = data.month.split('-').map(Number);
  const today = todayISO();
  const holidays = new Set(data.holidays);
  const iso = d => `${data.month}-${String(d).padStart(2, '0')}`;
  const isOff = d => [0, 6].includes(new Date(year, month - 1, d).getDay()) || holidays.has(iso(d));

  let h = `<tr><th>${t('staff.th.name')}</th>`;
  for (let d = 1; d <= data.days_in_month; d++) {
    h += `<th class="${isOff(d) ? 'is-weekend' : ''}${iso(d) === today ? ' is-today' : ''}">${d}</th>`;
  }
  h += `<th>${t('staff.sheet.absent')}</th><th>${t('staff.sheet.late')}</th><th>${t('staff.sheet.excused')}</th></tr>`;
  head.innerHTML = h;

  if (!data.staff.length) { body.innerHTML = `<tr><td colspan="${data.days_in_month + 4}" class="text-muted">${t('att.staffEmpty')}</td></tr>`; return; }

  body.innerHTML = data.staff.map(s => {
    let cells = '';
    for (let d = 1; d <= data.days_in_month; d++) {
      const day = iso(d);
      const status = s.days[String(d)] || null;
      const todayCls = day === today ? ' is-today' : '';
      if (!status && isOff(d)) {
        const title = holidays.has(day) ? t('staff.sheet.holiday') : t('tabel.legend.weekend');
        cells += `<td class="is-weekend${todayCls}"><span class="tabel-day-cell w-cell" title="${title}">–</span></td>`;
        continue;
      }
      if (day > today) { cells += `<td class="${todayCls}"></td>`; continue; }
      const counted = day >= (s.hire_date || '') && day < today;
      const inner = status
        ? tabelCell(status)
        : `<span class="tabel-day-cell ${counted ? 'u-cell' : ''}" title="${counted ? t('staff.sheet.unmarked') : ''}">${counted ? '?' : ''}</span>`;
      cells += `<td class="${todayCls}"><button type="button" class="staff-sheet-day" onclick="openStaffDay('${day}')" aria-label="${escapeHtml(s.name)} ${day}">${inner}</button></td>`;
    }
    return `<tr>
      <td><b>${escapeHtml(s.name)}</b></td>
      ${cells}
      <td><b class="${s.absent_days ? 'text-rose' : ''}">${s.absent_days}</b>${s.unmarked_days ? ` <small class="text-muted" title="${t('staff.sheet.unmarked')}">(${s.unmarked_days}?)</small>` : ''}</td>
      <td><b class="${s.late_days ? 'text-amber' : ''}">${s.late_days}</b></td>
      <td><b>${s.excused_days}</b></td>
    </tr>`;
  }).join('');
}

function openStaffDay(day) {
  const input = document.getElementById('staffAttDate');
  if (!input) return;
  input.value = day;
  loadStaffAttendance();
  document.querySelector('.staff-att-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function onStaffMonthChange() {
  reloadPayroll();
  loadStaffSheet();
}

// Settings: payroll rules and holidays
const PAYROLL_RULES = { holidays: [] };

async function loadPayrollRules() {
  try {
    const res = await apiFetch(`${API_BASE}/settings/payroll`);
    if (!res.ok) return;
    const data = await res.json();
    document.getElementById('settingsLatePct').value = data.late_penalty_pct ?? 25;
    document.getElementById('settingsDeductionStart').value = data.deduction_start || '';
    PAYROLL_RULES.holidays = data.holidays || [];
    renderPayrollHolidays();
  } catch (_) { /* leave the form as is */ }
}

function renderPayrollHolidays() {
  const list = document.getElementById('settingsHolidayList');
  if (!list) return;
  const editable = can('settings.manage');
  list.innerHTML = PAYROLL_RULES.holidays.length
    ? PAYROLL_RULES.holidays.map((h, i) => `
      <div class="holiday-row">
        <span class="holiday-date">${escapeHtml(h.date)}</span>
        <span class="holiday-name">${escapeHtml(h.name || '')}</span>
        ${editable ? `<button type="button" class="btn btn-sm btn-secondary" onclick="removePayrollHoliday(${i})">${t('common.delete')}</button>` : ''}
      </div>`).join('')
    : `<p class="text-muted">${t('settings.noHolidays')}</p>`;
}

function addPayrollHoliday() {
  const dateEl = document.getElementById('settingsHolidayDate');
  const nameEl = document.getElementById('settingsHolidayName');
  if (!dateEl.value) { showToast(t('settings.holidayDateRequired'), 'warning'); return; }
  PAYROLL_RULES.holidays = PAYROLL_RULES.holidays.filter(h => h.date !== dateEl.value)
    .concat({ date: dateEl.value, name: nameEl.value.trim() || null })
    .sort((a, b) => a.date.localeCompare(b.date));
  dateEl.value = '';
  nameEl.value = '';
  renderPayrollHolidays();
}

function removePayrollHoliday(index) {
  PAYROLL_RULES.holidays.splice(index, 1);
  renderPayrollHolidays();
}

async function savePayrollRules() {
  const pct = parseFloat(document.getElementById('settingsLatePct').value);
  const start = document.getElementById('settingsDeductionStart').value;
  if (!(pct >= 0 && pct <= 100) || !start) { showToast(t('settings.payrollInvalid'), 'warning'); return; }
  try {
    const res = await apiFetch(`${API_BASE}/settings/payroll`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ late_penalty_pct: pct, deduction_start: start, holidays: PAYROLL_RULES.holidays }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : t('settings.payrollInvalid'));
    PAYROLL_RULES.holidays = data.holidays;
    renderPayrollHolidays();
    showToast(t('settings.payrollSaved'), 'success');
    reloadPayroll();
    loadStaffSheet();
    if (can('audit.view')) loadAuditLog();
  } catch (err) {
    showToast(err instanceof TypeError ? t('toast.genericError') : err.message, 'warning');
  }
}

function openAddStaffModal() {
  document.getElementById('addStaffForm').reset();
  document.getElementById('newStaffHireDate').value = todayISO();
  const roles = [...new Set(STATE.staffPayroll.map(p => p.role).filter(Boolean))].sort();
  document.getElementById('staffRoleOptions').innerHTML = roles.map(r => `<option value="${escapeHtml(r)}"></option>`).join('');
  openModal('addStaffModal');
}

async function handleAddStaffSubmit(e) {
  e.preventDefault();
  const body = {
    name: document.getElementById('newStaffName').value.trim(),
    role: document.getElementById('newStaffRole').value.trim(),
    phone: document.getElementById('newStaffPhone').value.trim(),
    base_salary: parseFloat(document.getElementById('newStaffSalary').value),
    hire_date: document.getElementById('newStaffHireDate').value || null,
  };
  const btn = document.getElementById('addStaffSubmitBtn');
  btn.disabled = true;
  try {
    const res = await apiFetch(`${API_BASE}/staff`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(Array.isArray(data.detail) ? t('kitchen.incompleteData') : (data.detail || t('common.error')));
    closeModal('addStaffModal');
    showToast(t('staff.added', { name: data.name }), 'success');
    syncWithBackend();
    if (can('staff.view')) loadStaffAttendance();
  } catch (err) {
    showToast(err.message, 'warning');
  } finally {
    btn.disabled = false;
  }
}

async function deleteStaff(staffId) {
  const person = STATE.staffPayroll.find(p => p.staff_id === staffId);
  const name = person ? person.staff_name : '';
  if (!confirm(t('staff.confirmDelete', { name }))) return;
  try {
    const res = await apiFetch(`${API_BASE}/staff/${encodeURIComponent(staffId)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || t('common.error'));
    showToast(t('staff.deleted', { name }), 'warning');
    syncWithBackend();
    if (can('staff.view')) loadStaffAttendance();
  } catch (err) {
    showToast(err.message, 'warning');
  }
}

async function payStaffSalary(payrollId, amount) {
  try {
    const res = await apiFetch(`${API_BASE}/staff/pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payroll_id: payrollId, amount: amount })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || t('toast.genericError'));
    showToast(t('staff.paySuccess'), 'success');
  } catch (err) {
    // A network failure surfaces as a TypeError ("Failed to fetch"); show our own message instead.
    showToast(err instanceof TypeError ? t('toast.genericError') : err.message, 'warning');
  } finally {
    syncWithBackend();
  }
}

// ============================================================================
// 6. Shartnomalar va Tibbiy Hujjatlar
// ============================================================================

function renderContractsTable() {
  const tbody = document.getElementById('contractsTableBody');
  if (!tbody) return;

  tbody.innerHTML = STATE.children.map(c => `
    <tr>
      <td><code>SH-2025-${c.id.toUpperCase()}</code></td>
      <td>
        <b>${c.name}</b><br>
        <small style="color: var(--text-muted);">${c.group}</small>
      </td>
      <td>
        ${c.parentName}<br>
        <small style="color: #6366f1;">${c.parentPhone}</small>
      </td>
      <td>01.09.2025</td>
      <td><span class="badge badge-emerald">${t('contracts.allVaccinations')}</span></td>
      <td><span class="badge badge-emerald">${t('contracts.certAvailable')}</span></td>
      <td class="text-right">
        <button class="btn btn-sm btn-secondary" onclick="viewChildContract('${c.id}')">${t('contracts.th.contract')}</button>
      </td>
    </tr>
  `).join('');
}

function viewChildContract(childId) {
  const child = STATE.children.find(c => c.id === childId) || STATE.children[0];
  if (!child) return;

  document.getElementById('contractDocNumber').innerText = `SH-2025-${child.id.toUpperCase()}`;
  document.getElementById('contractDocChildName').innerText = child.name;
  document.getElementById('contractDocParentName').innerText = child.parentName;
  document.getElementById('contractDocSignParent').innerText = child.parentName;
  document.getElementById('contractDocSignPhone').innerText = child.parentPhone;

  openModal('contractViewModal');
}

// Helper: Populate selects in modals
function populateSelectOptions() {
  const tmaSelect = document.getElementById('tmaChildSelect');
  if (tmaSelect && STATE.children.length > 0) {
    tmaSelect.innerHTML = STATE.children.map((c, i) => `<option value="${i}">${c.name} (${c.group})</option>`).join('');
  }

  const groupOptions = STATE.groups.map(g => `<option value="${g.name}">${g.name} (${g.age})</option>`).join('');

  const newChildGroupSelect = document.getElementById('newChildGroup');
  if (newChildGroupSelect && STATE.groups.length > 0) {
    const prev = newChildGroupSelect.value;
    newChildGroupSelect.innerHTML = groupOptions;
    if ([...newChildGroupSelect.options].some(o => o.value === prev)) newChildGroupSelect.value = prev;
  }

  const attGroupSelect = document.getElementById('attendanceGroupSelect');
  if (attGroupSelect && STATE.groups.length > 0) {
    const prev = attGroupSelect.value;
    attGroupSelect.innerHTML = groupOptions;
    if ([...attGroupSelect.options].some(o => o.value === prev)) attGroupSelect.value = prev;
  }
}

function renderGroupFilterTabs() {
  const container = document.getElementById('groupFilterTabs');
  if (!container) return;
  const currentActive = container.querySelector('.filter-tab.active')?.getAttribute('data-group') || 'ALL';

  const tabsHtml = [`<button class="filter-tab" data-group="ALL">${t('common.all')}</button>`]
    .concat(STATE.groups.map(g => `<button class="filter-tab" data-group="${g.name}">${g.name}</button>`))
    .join('');
  container.innerHTML = tabsHtml;

  container.querySelectorAll('.filter-tab').forEach(btn => {
    if (btn.getAttribute('data-group') === currentActive) btn.classList.add('active');
    btn.addEventListener('click', () => {
      container.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderChildrenTable();
      renderGroupTabActions();
    });
  });
  if (!container.querySelector('.filter-tab.active')) container.querySelector('.filter-tab')?.classList.add('active');
  renderGroupTabActions();
}

// Edit / delete buttons for the group picked in the children page tabs.
function renderGroupTabActions() {
  const box = document.getElementById('groupTabActions');
  if (!box) return;
  const name = document.querySelector('#groupFilterTabs .filter-tab.active')?.getAttribute('data-group');
  const g = STATE.groups.find(x => x.name === name);
  if (!g) { box.innerHTML = ''; return; }
  const id = escapeHtml(g.id);
  box.innerHTML = [
    can('groups.manage') ? `<button type="button" class="btn btn-sm btn-secondary" onclick="openEditGroupModal('${id}')">${PENCIL_ICON}<span>${t('groups.edit.button')}</span></button>` : '',
    can('groups.delete') ? `<button type="button" class="btn btn-sm btn-danger" onclick="openDeleteGroupModal('${id}')">${t('groups.delete.button')}</button>` : '',
  ].join('');
}

function setGroupModalMode(group) {
  STATE.editingGroupId = group ? group.id : null;
  document.getElementById('groupModalTitle').textContent = group ? t('modal.addGroup.titleEdit', { name: group.name }) : t('modal.addGroup.titleNew');
  document.getElementById('groupModalSubmit').textContent = group ? t('common.save') : t('modal.addGroup.submitNew');
  document.getElementById('newGroupName').disabled = !!group;
  document.getElementById('groupModalDelete').hidden = !(group && can('groups.delete'));
}

function openAddGroupModal() {
  document.getElementById('addGroupForm').reset();
  document.getElementById('newGroupCapacity').value = 25;
  setGroupModalMode(null);
  openModal('addGroupModal');
}

function openEditGroupModal(groupId) {
  const g = STATE.groups.find(x => x.id === groupId);
  if (!g) return;
  document.getElementById('addGroupForm').reset();
  document.getElementById('newGroupName').value = g.name;
  document.getElementById('newGroupAge').value = g.age || '';
  document.getElementById('newGroupCapacity').value = g.capacity;
  document.getElementById('newGroupTeacher').value = g.teacher || '';
  document.getElementById('newGroupTeacher2').value = g.teacher2 || '';
  document.getElementById('newGroupFee').value = g.fee ?? '';
  setGroupModalMode(g);
  openModal('addGroupModal');
}

function openDeleteGroupModal(groupId = STATE.editingGroupId) {
  const g = STATE.groups.find(x => x.id === groupId);
  if (!g) return;
  STATE.deletingGroupId = g.id;
  const others = STATE.groups.filter(x => x.id !== g.id);
  const select = document.getElementById('deleteGroupMoveTo');
  const submit = document.getElementById('deleteGroupSubmit');
  document.getElementById('deleteGroupTitle').textContent = t('groups.delete.titleNamed', { name: g.name });
  select.innerHTML = others.map(x => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)} (${x.count}/${x.capacity})</option>`).join('');
  let text;
  if (!g.count) text = t('groups.delete.empty', { name: g.name });
  else if (others.length) text = t('groups.delete.hasChildren', { name: g.name, n: g.count });
  else text = t('groups.delete.noTarget', { name: g.name, n: g.count });
  document.getElementById('deleteGroupText').textContent = text;
  document.getElementById('deleteGroupMoveField').hidden = !(g.count && others.length);
  submit.disabled = !!(g.count && !others.length);
  closeModal('addGroupModal');
  openModal('deleteGroupModal');
}

async function handleDeleteGroupSubmit(e) {
  e.preventDefault();
  const g = STATE.groups.find(x => x.id === STATE.deletingGroupId);
  if (!g) return;
  const moveTo = g.count ? document.getElementById('deleteGroupMoveTo').value : '';
  const query = moveTo ? `?move_to=${encodeURIComponent(moveTo)}` : '';
  const submit = document.getElementById('deleteGroupSubmit');
  submit.disabled = true;
  try {
    const res = await apiFetch(`${API_BASE}/groups/${encodeURIComponent(g.id)}${query}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || t('toast.genericError'));
    closeModal('deleteGroupModal');
    showToast(data.moved
      ? t('groups.delete.doneMoved', { name: g.name, n: data.moved, target: data.moved_to })
      : t('groups.delete.done', { name: g.name }), 'success');
    syncWithBackend();
  } catch (err) {
    showToast(err.message || t('toast.genericError'), 'warning');
  } finally {
    submit.disabled = false;
  }
}

function handleAddGroupSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('newGroupName').value.trim();
  const body = {
    age_category: document.getElementById('newGroupAge').value.trim(),
    capacity: parseInt(document.getElementById('newGroupCapacity').value, 10),
    teacher_name: document.getElementById('newGroupTeacher').value.trim(),
    teacher2_name: document.getElementById('newGroupTeacher2').value.trim() || null,
    monthly_fee: parseFloat(document.getElementById('newGroupFee').value),
  };
  const editing = STATE.editingGroupId;

  apiFetch(editing ? `${API_BASE}/groups/${encodeURIComponent(editing)}` : `${API_BASE}/groups`, {
    method: editing ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(editing ? body : { name, ...body })
  }).then(async r => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || t('toast.genericError'));
    return data;
  }).then(() => {
    closeModal('addGroupModal');
    syncWithBackend();
    showToast(editing ? t('modal.addGroup.updated', { name }) : t('modal.addGroup.added', { name }), 'success');
  }).catch(err => {
    showToast(err.message || t('toast.genericError'), 'warning');
  });
}

function calcPricingDiscount() {
  const base = parseFloat(document.getElementById('editPricingBasePrice').value);
  const percent = parseFloat(document.getElementById('editPricingDiscountPercent').value);
  const resultLabel = document.getElementById('editPricingCalcResult');

  if (isNaN(base) || isNaN(percent) || percent < 0 || percent > 100) {
    resultLabel.innerText = t('modal.editPricing.calcHint');
    return;
  }

  const final = Math.round(base * (1 - percent / 100) / 1000) * 1000;
  document.getElementById('editPricingPrice').value = final;
  document.getElementById('editPricingDiscount').value = `${percent}%`;
  resultLabel.innerHTML = t('modal.editPricing.calcResult', { final: `<b style="color: var(--color-emerald);">${formatMoney(final)}</b>`, base: formatMoney(base), percent });
}

// ============================================================================
// Standard UI Engines: Navigation, Dashboard, Attendance, Billing
// ============================================================================

function initTheme() {
  STATE.theme = document.documentElement.getAttribute('data-theme') || 'light';
  const toggleBtn = document.getElementById('themeToggle');
  toggleBtn?.addEventListener('click', () => {
    const next = STATE.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    STATE.theme = next;
    try { localStorage.setItem('bogcha_theme', next); } catch (e) {}
  });
}

function updateLangToggleLabel() {
  const label = document.getElementById('langToggleLabel');
  if (label) label.textContent = getLang() === 'uz' ? 'RU' : 'UZ';
}

function initLang() {
  updateLangToggleLabel();
  document.getElementById('langToggle')?.addEventListener('click', () => {
    setLang(getLang() === 'uz' ? 'ru' : 'uz');
    applyTranslations(document);
    updateLangToggleLabel();
    // Re-render everything built dynamically in JS so it picks up the new language too.
    if (STATE.currentRole) applyRoleAccess(STATE.currentRole);
    syncWithBackend();
    if (can('photos.send')) loadPhotoStatus();
    if (can('billing.remind')) loadReminders();
    if (can('staff.view')) loadStaffAttendance();
    if (can('kitchen.view')) loadKitchenReports();
  });
}

function initNavigation() {
  document.querySelectorAll('.sidebar-nav .nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab(btn.getAttribute('data-tab'));
      setMobileNav(false);
    });
  });
}

function setMobileNav(open) {
  document.body.classList.toggle('nav-open', open);
  const toggle = document.getElementById('menuToggle');
  if (toggle) {
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? t('common.closeMenu') : t('common.openMenu'));
  }
}

function initMobileNav() {
  document.getElementById('menuToggle')?.addEventListener('click', () => setMobileNav(!document.body.classList.contains('nav-open')));
  document.getElementById('sidebarScrim')?.addEventListener('click', () => setMobileNav(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setMobileNav(false); });
}

function switchTab(tabId) {
  document.querySelectorAll('.sidebar-nav .nav-item').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-tab') === tabId);
  });
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('active', p.id === `tab-${tabId}`);
  });
  STATE.currentTab = tabId;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function initLiveClock() {
  const container = document.getElementById('liveClock');
  if (!container) return;
  setInterval(() => {
    const now = new Date();
    container.innerHTML = `
      <span class="clock-date">${now.getDate()} ${monthName(now.getMonth() + 1)}, ${now.getFullYear()}</span>
      <span class="clock-time">${now.toLocaleTimeString('uz-UZ', { hour12: false })}</span>
    `;
  }, 1000);
}

function monthName(monthNumber1to12) {
  return t(`month.${monthNumber1to12}`);
}

// Russian needs the genitive case and no dash ("27 октября"); Uzbek has no
// case agreement and uses a dash ("27-oktabr").
function formatDayMonth(day, monthNumber1to12) {
  return getLang() === 'ru'
    ? `${day} ${t(`monthgen.${monthNumber1to12}`)}`
    : `${day}-${monthName(monthNumber1to12).toLowerCase()}`;
}

function periodLabel(period) {
  const [y, m] = period.split('-').map(Number);
  return `${monthName(m)} ${y}`;
}

function shortMoney(amount) {
  if (amount >= 1e6) return `${(amount / 1e6).toFixed(amount >= 1e7 ? 0 : 1).replace('.0', '')} mln`;
  if (amount >= 1e3) return `${Math.round(amount / 1e3)} ming`;
  return String(Math.round(amount || 0));
}

function renderDashboard() {
  const d = STATE.dashboard;
  if (!d) return;
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  set('kpiTotalChildren', `${d.total_children}`);
  set('kpiChildrenNote', t('dash.groupsCountNote', { n: STATE.groups.length }));
  set('kpiAttendanceRate', `${d.present_today} / ${d.total_children}`);
  set('kpiAttendanceNote', t('dash.attendanceNote', { absent: d.absent_today, unmarked: d.unmarked_today }));
  set('kpiStaff', `${d.staff_present} / ${d.staff_total}`);
  set('kpiStaffNote', d.staff_marked ? `${d.staff_total - d.staff_marked} ${t('att.staffMarkedSuffix')}` : t('dash.staffNote.unmarked'));
  set('kpiRevenue', formatMoney(d.monthly_revenue));
  set('kpiRevenueNote', d.monthly_revenue ? t('dash.revenueNote', { percent: d.collection.percent }) : t('dash.revenueNote.empty'));
  set('kpiDebts', formatMoney(d.total_debts));
  set('kpiDebtsNote', d.collection.overdue_count ? t('dash.debtsNote', { count: d.collection.overdue_count }) : t('dash.debtsNote.empty'));

  const list = document.getElementById('attentionList');
  if (list) {
    list.innerHTML = d.attention.length
      ? d.attention.map((a, i) => `
        <li><button type="button" class="todo-item" data-kind="${a.kind}" onclick="openAttention(${i})">
          <span class="todo-text"><b>${escapeHtml(a.label)}</b><small>${escapeHtml(a.detail)}</small></span>
          <span class="todo-count">${a.count}</span>
          <svg class="todo-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
        </button></li>`).join('')
      : `<li class="todo-empty">${t('dash.todo.empty')}</li>`;
  }

  const debtors = document.getElementById('topDebtorsList');
  if (debtors) {
    const rows = d.collection.top_debtors;
    debtors.innerHTML = rows.length
      ? rows.map(r => `
        <li><button type="button" class="debtor-item" onclick="openRecordPaymentModal('${escapeHtml(r.child_id)}')">
          <span class="child-avatar" aria-hidden="true">${escapeHtml(r.name.split(' ').filter(Boolean).map(n => n[0]).join('').slice(0, 2))}</span>
          <span class="debtor-text"><b>${escapeHtml(r.name)}</b><small>${escapeHtml(r.group)}${r.overdue ? t('dash.debtorOverdueSuffix') : ''}</small></span>
          <span class="debtor-amount ${r.overdue ? 'is-overdue' : ''}">${shortMoney(r.debt)}</span>
        </button></li>`).join('')
      : `<li class="todo-empty">${t('dash.debtors.empty')}</li>`;
  }

  const c = d.collection;
  const block = document.getElementById('collectionBlock');
  if (block) {
    block.innerHTML = `
      <div class="collection-head"><span>${periodLabel(c.period)}</span><b>${c.percent}%</b></div>
      <div class="collection-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${c.percent}"><span style="width:${Math.min(100, c.percent)}%"></span></div>
      <p class="collection-note">${t('dash.collectionNote', { due: formatMoney(c.due), collected: formatMoney(c.collected), left: formatMoney(c.left) })}</p>`;
  }
  renderWeeklyChart();
}

function openAttention(index) {
  const item = STATE.dashboard?.attention[index];
  if (!item) return;
  switchTab(item.tab);
  if (item.kind === 'attendance' && item.group) {
    const select = document.getElementById('attendanceGroupSelect');
    if (select && [...select.options].some(o => o.value === item.group)) { select.value = item.group; loadAttendance(); }
  }
  if (item.kind === 'groups') document.getElementById('groupsMiniGrid')?.scrollIntoView({ behavior: 'smooth' });
}

function renderWeeklyChart() {
  const container = document.getElementById('weeklyChartContainer');
  if (!container) return;
  const history = STATE.dashboard?.income_history || [];
  const max = Math.max(0, ...history.map(h => h.amount));
  if (!max) {
    container.innerHTML = `<p class="chart-empty">${t('dash.income.empty')}</p>` + history.map(h => `
      <div class="bar-column"><div class="bar-pill is-empty"></div><span class="bar-label">${h.label}</span></div>`).join('');
    return;
  }
  container.innerHTML = history.map((h, i) => `
    <div class="bar-column ${i === history.length - 1 ? 'is-current' : ''}">
      <div class="bar-pill" style="height: ${Math.max(2, Math.round(h.amount / max * 100))}%;" data-percent="${h.amount ? shortMoney(h.amount) : ''}"></div>
      <span class="bar-label">${h.label}</span>
    </div>`).join('');
}

function renderActivities() {
  const feed = document.getElementById('activityFeed');
  if (!feed) return;
  // Register marks are reserved for attendance; other events get a plain ink dot.
  // Activity text comes from the server's own Uzbek-language log messages
  // (always Uzbek regardless of UI language, like the Telegram messages),
  // so this match is intentionally against the fixed Uzbek words.
  const markFor = text => {
    if (/kech keldi/i.test(text)) return 'LATE';
    if (/sababli/i.test(text)) return 'EXCUSED';
    if (/kelmadi/i.test(text)) return 'ABSENT';
    if (/keldi/i.test(text)) return 'PRESENT';
    return null;
  };
  feed.innerHTML = STATE.activities.slice(0, 5).map(act => {
    const mark = markFor(act.text);
    return `
    <div class="activity-item">
      <div class="activity-icon" data-mark="${mark || 'EVENT'}">${mark ? attMarkSvg(mark) : '<span class="activity-dot"></span>'}</div>
      <div class="activity-details">
        <p>${escapeHtml(act.text)}</p>
        <small>${escapeHtml(act.time)} da</small>
      </div>
    </div>
  `;
  }).join('');
}

function renderGroupsMiniGrid() {
  const container = document.getElementById('groupsMiniGrid');
  if (!container) return;
  const badge = document.getElementById('groupsCountBadge');
  if (badge) badge.textContent = t('dash.groupsCountNote', { n: STATE.groups.length });
  const R = 26, CIRC = 2 * Math.PI * R;
  container.innerHTML = STATE.groups.map(g => {
    const ratio = g.capacity ? g.count / g.capacity : 0;
    const state = g.count > g.capacity ? 'over' : g.count === g.capacity ? 'full' : 'open';
    const note = state === 'over' ? t('dash.group.overCapacity', { n: g.count - g.capacity })
      : state === 'full' ? t('dash.group.full') : t('dash.group.openSpots', { n: g.capacity - g.count });
    const teachers = (g.teachers || []).length
      ? g.teachers.map(name => `<span class="teacher-chip">${escapeHtml(name)}</span>`).join('')
      : `<span class="teacher-chip is-missing">${t('modal.addGroup.teacherMissing')}</span>`;
    return `
      <div class="group-card" data-state="${state}">
        <div class="group-ring" aria-label="${g.count} / ${g.capacity}">
          <svg viewBox="0 0 64 64" aria-hidden="true">
            <circle cx="32" cy="32" r="${R}" class="ring-track"/>
            <circle cx="32" cy="32" r="${R}" class="ring-fill" stroke-dasharray="${(Math.min(1, ratio) * CIRC).toFixed(1)} ${CIRC.toFixed(1)}"/>
          </svg>
          <span><b>${g.count}</b>/ ${g.capacity}</span>
        </div>
        <div class="group-body">
          <div class="group-card-header">
            <span class="group-name">${escapeHtml(g.name)}</span>
            ${can('groups.manage') ? `<button type="button" class="btn btn-sm btn-secondary" onclick="openEditGroupModal('${escapeHtml(g.id)}')" aria-label="${escapeHtml(g.name)} guruhini tahrirlash">${PENCIL_ICON}</button>` : ''}
          </div>
          <p class="group-teacher">${escapeHtml(g.age || '')}</p>
          <div class="teacher-chips">${teachers}</div>
          <p class="group-status">${note}</p>
        </div>
      </div>
    `;
  }).join('');
}

function renderChildrenTable() {
  const tbody = document.getElementById('childrenTableBody');
  if (!tbody) return;
  const searchVal = (document.getElementById('childSearchFilter')?.value || '').toLowerCase();
  const statusFilter = document.getElementById('childStatusFilter')?.value || 'ALL';
  const activeTabBtn = document.querySelector('.filter-tab.active');
  const groupFilter = activeTabBtn ? activeTabBtn.getAttribute('data-group') : 'ALL';

  const filtered = STATE.children.filter(c => {
    const matchSearch = c.name.toLowerCase().includes(searchVal) || c.parentName.toLowerCase().includes(searchVal) || c.parentPhone.includes(searchVal);
    const matchStatus = statusFilter === 'ALL' ? true : statusFilter === 'DEBT' ? c.paymentStatus === 'DEBT' : c.status === statusFilter;
    const matchGroup = groupFilter === 'ALL' ? true : c.group === groupFilter;
    return matchSearch && matchStatus && matchGroup;
  });

  const hideRestrictedColumns = !can('children.finance');
  const canEditHealth = can('children.health.edit');
  const canEditPricing = can('children.pricing.edit');
  const canDelete = can('children.delete');

  tbody.innerHTML = filtered.map(child => {
    const initials = child.name.split(' ').filter(Boolean).map(n => n[0]).join('').slice(0, 2);
    const healthy = /^\s*(yo'?q|sog'?lom|соғлом|согл?ом|здоров|нет|-|—)?\s*$/i.test(child.allergies || '');
    const healthDisplay = healthy
      ? `<span class="text-emerald">${t('status.healthy')}</span>`
      : `<span class="text-rose" style="font-weight: 600;">${escapeHtml(child.allergies)}</span>`;
    return `
      <tr>
        <td>
          <div class="child-cell">
            <div class="child-avatar">${initials}</div>
            <div>
              <span class="child-name">${escapeHtml(child.name)}</span>
              <small style="color: var(--text-muted); font-size: 0.78rem;">ID: ${escapeHtml(child.id)}</small>
            </div>
          </div>
        </td>
        <td><span class="badge badge-indigo">${escapeHtml(child.group)}</span></td>
        <td>${escapeHtml(child.birthDate)}</td>
        <td>
          <div><b>${escapeHtml(child.parentName)}</b></div>
          <small style="color: var(--color-primary);">${escapeHtml(child.parentPhone)}</small>
          ${can('parents.invite') ? `<div><button class="btn btn-sm btn-secondary tg-btn" onclick="openTelegramLink('${escapeHtml(child.id)}')">${t('children.telegramBtn')}</button></div>` : ''}
        </td>
        <td>
          ${healthDisplay}
          ${canEditHealth ? `<button class="btn btn-sm btn-secondary" style="margin-left:6px;" onclick="openEditHealthModal('${child.id}', '${child.name.replace(/'/g, "\\'")}', '${(child.allergies || '').replace(/'/g, "\\'")}')" title="${t('common.edit')}" aria-label="${t('common.edit')}">${PENCIL_ICON}</button>` : ''}
        </td>
        ${hideRestrictedColumns ? '' : `<td>${child.discount ? `<span class="badge badge-amber">${escapeHtml(child.discount)}</span>` : '—'}</td>
        <td>${child.note ? escapeHtml(child.note) : '—'}</td>
        <td>
          ${child.listedPrice != null ? formatMoney(child.listedPrice) : `<span style="color: var(--text-muted);">${t('children.priceUnset')}</span>`}
          ${canEditPricing ? `<button class="btn btn-sm btn-secondary" style="margin-left:6px;" onclick="openEditPricingModal('${child.id}', '${child.name.replace(/'/g, "\\'")}', '${(child.discount || '').replace(/'/g, "\\'")}', '${(child.note || '').replace(/'/g, "\\'")}', ${child.listedPrice != null ? child.listedPrice : 'null'})" title="${t('common.edit')}" aria-label="${t('common.edit')}">${PENCIL_ICON}</button>` : ''}
        </td>`}
        ${hideRestrictedColumns ? '' : `
        <td>
          ${child.paymentStatus === 'PAID' ? `<span class="badge badge-emerald">${t('status.paid')}</span>` : `<span class="badge badge-rose">${t('status.debt')} (${formatMoney(child.debt)})</span>`}
        </td>
        <td class="text-right">
          <button class="btn btn-sm btn-secondary" onclick="viewChildReceipt('${child.id}')">${t('children.receiptBtn')}</button>
          <button class="btn btn-sm btn-secondary" onclick="viewChildContract('${child.id}')">${t('children.contractBtn')}</button>
        </td>`}
        ${canDelete ? `
        <td class="text-right col-actions">
          <button class="btn btn-sm btn-danger" onclick="handleDeleteChild('${child.id}', '${child.name.replace(/'/g, "\\'")}')">${t('common.delete')}</button>
        </td>` : ''}
      </tr>
    `;
  }).join('');
}

// ============================================================================
// Rasm yuborish (send photos to parents via Telegram)
// ============================================================================

const PHOTOS = { items: [], channelLinked: false, sending: false };
const PHOTO_MAX = 10;
const PHOTO_EDGE = 1600;

function initPhotos() {
  const input = document.getElementById('photoFiles');
  if (!input) return;
  input.addEventListener('change', async () => {
    const files = [...input.files].filter(f => /^image\/(jpeg|png)$/.test(f.type));
    input.value = '';
    for (const file of files) {
      if (PHOTOS.items.length >= PHOTO_MAX) { showToast(t('toast.photoLimit', { max: PHOTO_MAX }), 'warning'); break; }
      try { PHOTOS.items.push(await resizeImage(file)); } catch (e) { showToast(t('toast.photoReadFailed', { name: file.name }), 'warning'); }
    }
    renderPhotoPreviews();
  });
  document.querySelectorAll('input[name="photoTarget"]').forEach(r => r.addEventListener('change', updatePhotoForm));
  document.getElementById('photoChildSelect').addEventListener('change', updatePhotoForm);
  document.getElementById('photoPreviews').addEventListener('click', e => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    PHOTOS.items.splice(Number(btn.dataset.remove), 1);
    renderPhotoPreviews();
  });
  document.getElementById('photoForm').addEventListener('submit', sendPhotos);
  document.getElementById('photoConnectForm').addEventListener('submit', connectPhotoChannel);
}

// Downscale in the browser: faster uploads from phones, and Telegram recompresses anyway.
function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, PHOTO_EDGE / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.86));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
    img.src = url;
  });
}

function renderPhotoPreviews() {
  document.getElementById('photoPreviews').innerHTML = PHOTOS.items.map((src, i) => `
    <figure class="photo-thumb">
      <img src="${src}" alt="${i + 1}">
      <button type="button" class="photo-remove" data-remove="${i}" aria-label="Rasmni olib tashlash"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </figure>`).join('');
  updatePhotoForm();
}

function populatePhotoChildren() {
  const select = document.getElementById('photoChildSelect');
  if (!select || !STATE.children.length) return;
  const prev = select.value;
  select.innerHTML = `<option value="">${t('photos.selectChild')}</option>` +
    STATE.children.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (${escapeHtml(c.group)})</option>`).join('');
  if ([...select.options].some(o => o.value === prev)) select.value = prev;
}

function updatePhotoForm() {
  const target = document.querySelector('input[name="photoTarget"]:checked')?.value;
  const select = document.getElementById('photoChildSelect');
  select.hidden = target !== 'child';
  if (target === 'child') populatePhotoChildren();
  const n = PHOTOS.items.length;
  document.getElementById('photoCount').textContent = n ? t('photos.selectedCount', { n }) : t('photos.noneSelected');
  const ready = n > 0 && !PHOTOS.sending && (target === 'channel' ? PHOTOS.channelLinked : !!select.value);
  document.getElementById('photoSendBtn').disabled = !ready;
}

async function loadPhotoStatus() {
  const status = document.getElementById('photoChannelStatus');
  try {
    const res = await apiFetch(`${API_BASE}/telegram/status`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || t('common.error'));
    const ch = data.channel;
    PHOTOS.channelLinked = ch.linked;
    status.dataset.state = ch.linked ? 'linked' : 'pending';
    status.innerHTML = ch.linked
      ? `${t('photos.linkedPrefix')} <b>${escapeHtml(ch.title)}</b>${ch.username ? ` (@${escapeHtml(ch.username)})` : ''}. ${escapeHtml(data.bot || 'bot')} ${t('photos.viaBot')}`
      : `${t('photos.notLinked')}${data.can_manage ? '' : t('photos.askDirector')}`;
    document.getElementById('photoPublicWarning').hidden = !(ch.linked && ch.public);
    document.getElementById('photoConnectForm').hidden = !data.can_manage;
  } catch (err) {
    status.textContent = err.message || t('common.error');
    status.dataset.state = 'error';
  }
  updatePhotoForm();
}

async function connectPhotoChannel(e) {
  e.preventDefault();
  const address = document.getElementById('photoChannelInput').value.trim();
  if (!address) return;
  try {
    const res = await apiFetch(`${API_BASE}/telegram/channel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || t('common.error'));
    showToast(t('modal.telegramLink.channelConnected', { title: data.title }), 'success');
    document.getElementById('photoChannelInput').value = '';
    loadPhotoStatus();
  } catch (err) {
    showToast(err.message, 'warning');
  }
}

async function sendPhotos(e) {
  e.preventDefault();
  const target = document.querySelector('input[name="photoTarget"]:checked').value;
  const childId = document.getElementById('photoChildSelect').value;
  const btn = document.getElementById('photoSendBtn');
  PHOTOS.sending = true;
  btn.textContent = t('common.sending');
  updatePhotoForm();
  try {
    const res = await apiFetch(`${API_BASE}/telegram/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, child_id: target === 'child' ? childId : null, caption: document.getElementById('photoCaption').value, images: PHOTOS.items })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || t('common.error'));
    showToast(t('toast.photosSent', { sent: data.sent, to: data.to }), 'success');
    PHOTOS.items = [];
    document.getElementById('photoCaption').value = '';
    renderPhotoPreviews();
  } catch (err) {
    showToast(err.message || t('toast.photosSendFailed'), 'warning');
  } finally {
    PHOTOS.sending = false;
    btn.textContent = t('common.send');
    updatePhotoForm();
  }
}

async function openTelegramLink(childId) {
  const status = document.getElementById('tgLinkStatus');
  const input = document.getElementById('tgLinkUrl');
  document.getElementById('tgLinkChild').textContent = '';
  status.textContent = t('common.loading');
  status.dataset.state = '';
  input.value = '';
  openModal('telegramLinkModal');
  try {
    const res = await apiFetch(`${API_BASE}/children/${encodeURIComponent(childId)}/telegram-link`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || t('common.error'));
    document.getElementById('tgLinkChild').textContent = data.child;
    status.textContent = data.linked
      ? t('modal.telegramLink.connected', { bot: data.bot })
      : t('modal.telegramLink.notConnected', { bot: data.bot });
    status.dataset.state = data.linked ? 'linked' : 'pending';
    input.value = data.url;
  } catch (err) {
    status.textContent = err.message || t('modal.telegramLink.loadFailed');
    status.dataset.state = 'error';
  }
}

async function copyTelegramLink() {
  const input = document.getElementById('tgLinkUrl');
  if (!input.value) return;
  try {
    await navigator.clipboard.writeText(input.value);
  } catch (e) {
    input.select();
    document.execCommand('copy');
  }
  showToast(t('modal.telegramLink.copied'), 'success');
}

function handleDeleteChild(childId, childName) {
  if (!confirm(t('confirm.deleteChild', { name: childName }))) {
    return;
  }
  apiFetch(`${API_BASE}/children/${childId}`, { method: 'DELETE' })
    .then(r => r.json())
    .then(() => {
      syncWithBackend();
      showToast(t('modal.addChild.deleted', { name: childName }), 'warning');
    })
    .catch(() => {
      showToast(t('toast.genericError'), 'warning');
    });
}

function openEditHealthModal(childId, childName, currentHealth) {
  document.getElementById('editHealthChildId').value = childId;
  document.getElementById('editHealthChildName').value = childName;
  document.getElementById('editHealthValue').value = currentHealth;
  openModal('editHealthModal');
}

function handleHealthSubmit(e) {
  e.preventDefault();
  const childId = document.getElementById('editHealthChildId').value;
  const health = document.getElementById('editHealthValue').value.trim();

  apiFetch(`${API_BASE}/children/${childId}/health`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ health })
  }).then(r => r.json()).then(() => {
    closeModal('editHealthModal');
    syncWithBackend();
    showToast(t('modal.editHealth.saved'), 'success');
  }).catch(() => {
    showToast(t('toast.genericError'), 'warning');
  });
}

function openEditPricingModal(childId, childName, discount, note, listedPrice) {
  document.getElementById('editPricingChildId').value = childId;
  document.getElementById('editPricingChildName').value = childName;
  document.getElementById('editPricingDiscount').value = discount || '';
  document.getElementById('editPricingNote').value = note || '';
  document.getElementById('editPricingPrice').value = listedPrice != null ? listedPrice : '';
  document.getElementById('editPricingBasePrice').value = listedPrice != null ? listedPrice : '';
  document.getElementById('editPricingDiscountPercent').value = '';
  document.getElementById('editPricingCalcResult').innerText = t('modal.editPricing.calcHint');
  openModal('editPricingModal');
}

function handlePricingSubmit(e) {
  e.preventDefault();
  const childId = document.getElementById('editPricingChildId').value;
  const discount = document.getElementById('editPricingDiscount').value.trim() || null;
  const note = document.getElementById('editPricingNote').value.trim() || null;
  const priceRaw = document.getElementById('editPricingPrice').value.trim();
  const monthly_fee = priceRaw === '' ? null : parseFloat(priceRaw);

  apiFetch(`${API_BASE}/children/${childId}/pricing`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ discount, note, monthly_fee })
  }).then(r => r.json()).then(() => {
    closeModal('editPricingModal');
    syncWithBackend();
    showToast(t('modal.editPricing.saved'), 'success');
  }).catch(() => {
    showToast(t('toast.genericError'), 'warning');
  });
}

// ============================================================================
// Kunlik davomat (Daily attendance)
// Marks wait ATT_UNDO_MS before saving, because saving "Keldi" messages the parent.
// ============================================================================

const ATT_STATUS_KEYS = [
  { key: 'PRESENT', i18n: 'att.status.present', cls: 'present' },
  { key: 'ABSENT', i18n: 'att.status.absent', cls: 'absent' },
  { key: 'EXCUSED', i18n: 'att.status.excused', cls: 'excused' },
  { key: 'LATE', i18n: 'att.status.late', cls: 'late' },
];

function attStatuses() {
  return ATT_STATUS_KEYS.map(s => ({ ...s, label: t(s.i18n) }));
}
const ATT_UNDO_MS = 5000;

const ATT = {
  rows: [],
  date: null,
  error: false,
  loading: false,
  requestId: 0,
  pending: new Map(), // childId -> { status, prev: {status, time}, timer, batch }
  failed: new Map(),  // childId -> { status, prev }
  saving: new Set(),
};

const PENCIL_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>';

function attMarkSvg(status) {
  return `<svg class="mark" aria-hidden="true"><use href="#mark-${status}"/></svg>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function attStatusMeta(key) {
  return attStatuses().find(s => s.key === key);
}

function attIsEditable() {
  return ATT.date === todayISO() && can('attendance.mark');
}

function attDisplayStatus(row) {
  return ATT.pending.get(row.id)?.status ?? row.status;
}

function initAttendance() {
  const dateInput = document.getElementById('attendanceDate');
  if (dateInput) {
    dateInput.value = todayISO();
    dateInput.max = todayISO();
    dateInput.addEventListener('change', loadAttendance);
  }
  document.getElementById('attendanceGroupSelect')?.addEventListener('change', loadAttendance);

  document.getElementById('attendanceCardsGrid')?.addEventListener('click', e => {
    const row = e.target.closest('.att-row');
    const statusBtn = e.target.closest('.att-btn');
    if (statusBtn && row) return setAttendance(row.dataset.id, statusBtn.dataset.status);
    if (e.target.closest('[data-undo]') && row) return undoAttendance(row.dataset.id);
    if (e.target.closest('[data-retry]') && row) return retryAttendance(row.dataset.id);
    if (e.target.closest('[data-reload]')) return loadAttendance();
  });

  window.addEventListener('pagehide', () => {
    if (ATT.pending.size) commitAttendance([...ATT.pending.keys()]);
  });
}

async function loadAttendance() {
  const group = document.getElementById('attendanceGroupSelect')?.value;
  const date = document.getElementById('attendanceDate')?.value || todayISO();
  if (ATT.pending.size) commitAttendance([...ATT.pending.keys()]);
  ATT.failed.clear();

  if (!group) {
    ATT.rows = [];
    ATT.date = date;
    renderAttendanceGrid();
    return;
  }

  const requestId = ++ATT.requestId;
  ATT.loading = true;
  renderAttendanceGrid();
  try {
    const res = await apiFetch(`${API_BASE}/attendance?group_name=${encodeURIComponent(group)}&att_date=${encodeURIComponent(date)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (requestId !== ATT.requestId) return;
    ATT.rows = data.map(r => ({ id: r.child_id, name: r.name, status: r.status, time: r.check_in_time }));
    ATT.error = false;
  } catch (err) {
    if (requestId !== ATT.requestId) return;
    ATT.rows = [];
    ATT.error = true;
  }
  ATT.date = date;
  ATT.loading = false;
  renderAttendanceGrid();
}

function renderAttendanceRow(row, editable) {
  const status = attDisplayStatus(row);
  const meta = attStatusMeta(status);
  const isPending = ATT.pending.has(row.id);
  const isSaving = ATT.saving.has(row.id);
  const failed = ATT.failed.has(row.id);
  const initials = row.name.split(' ').filter(Boolean).map(n => n[0]).join('').slice(0, 2);

  let metaText = meta ? meta.label : t('att.unmarkedLabel');
  if (meta && row.time && !isPending && (status === 'PRESENT' || status === 'LATE')) metaText += ` · ${row.time}`;

  let sync = '';
  if (isPending) {
    sync = `<span class="att-sync">${t('att.saving')} <button type="button" class="att-link" data-undo>${t('att.undo')}</button></span>`;
  } else if (isSaving) {
    sync = `<span class="att-sync">${t('att.savingNow')}</span>`;
  } else if (failed) {
    sync = `<span class="att-sync is-error">${t('att.saveFailed')} <button type="button" class="att-link" data-retry>${t('common.retry')}</button></span>`;
  }

  const buttons = attStatuses().map(s => `
    <button type="button" class="att-btn" data-status="${s.key}" aria-pressed="${status === s.key}" ${editable && !isSaving ? '' : 'disabled'}>${attMarkSvg(s.key)}${s.label}</button>
  `).join('');

  return `
    <article class="att-row${isPending ? ' is-pending' : ''}" data-id="${escapeHtml(row.id)}" data-status="${meta ? meta.cls : 'unmarked'}" style="--att-undo-ms: ${ATT_UNDO_MS}ms">
      <div class="att-row-head">
        <div class="child-avatar" aria-hidden="true">${escapeHtml(initials)}</div>
        <div class="att-info">
          <h4 class="att-name">${escapeHtml(row.name)}</h4>
          <span class="att-meta">${metaText}</span>
        </div>
        ${sync}
        <span class="att-mark" title="${meta ? meta.label : t('att.unmarkedLabel')}">${meta ? attMarkSvg(status) : ''}</span>
      </div>
      <div class="att-choices" role="group" aria-label="${escapeHtml(row.name)}: ${t('att.ariaLabel')}">${buttons}</div>
    </article>
  `;
}

function renderAttendanceGrid() {
  const grid = document.getElementById('attendanceCardsGrid');
  if (!grid) return;
  const editable = attIsEditable();

  if (ATT.loading && !ATT.rows.length) {
    grid.innerHTML = `<p class="att-empty">${t('att.loading')}</p>`;
  } else if (ATT.error) {
    grid.innerHTML = `<div class="att-empty"><p>${t('att.loadError')}</p><button type="button" class="btn btn-secondary" data-reload>${t('att.reload')}</button></div>`;
  } else if (!ATT.rows.length) {
    grid.innerHTML = `<p class="att-empty">${t('att.noChildren')}</p>`;
  } else {
    grid.innerHTML = ATT.rows.map(r => renderAttendanceRow(r, editable)).join('');
  }
  grid.setAttribute('aria-busy', String(ATT.loading));

  const title = document.getElementById('attTitle');
  const group = document.getElementById('attendanceGroupSelect')?.value;
  if (title && group && ATT.date) {
    const [y, m, d] = ATT.date.split('-').map(Number);
    title.textContent = `${group} · ${formatDayMonth(d, m)}, ${y}`;
  }

  const counts = { PRESENT: 0, ABSENT: 0, EXCUSED: 0, LATE: 0 };
  let unmarked = 0;
  ATT.rows.forEach(r => {
    const s = attDisplayStatus(r);
    if (counts[s] !== undefined) counts[s]++;
    else unmarked++;
  });
  document.getElementById('attCountPresent').innerText = counts.PRESENT;
  document.getElementById('attCountAbsent').innerText = counts.ABSENT;
  document.getElementById('attCountExcused').innerText = counts.EXCUSED;
  document.getElementById('attCountLate').innerText = counts.LATE;
  document.getElementById('attCountMarked').innerText = ATT.rows.length - unmarked;
  document.getElementById('attCountTotal').innerText = ATT.rows.length;

  const note = document.getElementById('attReadonlyNote');
  if (note) {
    note.hidden = editable || ATT.error || !ATT.rows.length;
    note.textContent = can('attendance.mark')
      ? t('att.readonlyNote.viewOnly')
      : t('att.readonlyNote.noMarkPerm');
  }

  const bar = document.getElementById('attActionBar');
  if (bar) bar.hidden = !editable || unmarked === 0;
  const label = document.getElementById('btnMarkRestLabel');
  if (label) label.innerText = unmarked === ATT.rows.length
    ? t('att.markRest.all', { count: unmarked })
    : t('att.markRest.some', { count: unmarked });
}

function setAttendance(childId, status) {
  const row = ATT.rows.find(r => r.id === childId);
  if (!row || !attIsEditable() || ATT.saving.has(childId)) return;

  const existing = ATT.pending.get(childId);
  const prev = existing ? existing.prev : { status: row.status, time: row.time };
  if (existing && !existing.batch) clearTimeout(existing.timer);

  if (status === prev.status) {
    ATT.pending.delete(childId);
  } else {
    ATT.failed.delete(childId);
    const timer = setTimeout(() => commitAttendance([childId]), ATT_UNDO_MS);
    ATT.pending.set(childId, { status, prev, timer, batch: false });
  }
  renderAttendanceGrid();
}

function undoAttendance(childId) {
  const p = ATT.pending.get(childId);
  if (!p) return;
  if (!p.batch) clearTimeout(p.timer);
  ATT.pending.delete(childId);
  renderAttendanceGrid();
}

function retryAttendance(childId) {
  const f = ATT.failed.get(childId);
  if (!f) return;
  ATT.failed.delete(childId);
  ATT.pending.set(childId, { status: f.status, prev: f.prev, timer: null, batch: false });
  commitAttendance([childId]);
}

function markAllPresent() {
  if (!attIsEditable()) return;
  const ids = ATT.rows.filter(r => !attDisplayStatus(r) && !ATT.saving.has(r.id)).map(r => r.id);
  if (!ids.length) return;

  const timer = setTimeout(() => commitAttendance(ids), ATT_UNDO_MS);
  ids.forEach(id => {
    const row = ATT.rows.find(r => r.id === id);
    ATT.failed.delete(id);
    ATT.pending.set(id, { status: 'PRESENT', prev: { status: row.status, time: row.time }, timer, batch: true });
  });
  renderAttendanceGrid();

  showActionToast(
    t('toast.attendanceMarkedPending', { count: ids.length, seconds: ATT_UNDO_MS / 1000 }),
    t('att.undo'),
    () => {
      clearTimeout(timer);
      ids.forEach(id => { if (ATT.pending.get(id)?.timer === timer) ATT.pending.delete(id); });
      renderAttendanceGrid();
    },
    ATT_UNDO_MS
  );
}

async function commitAttendance(ids) {
  const jobs = ids.map(id => [id, ATT.pending.get(id)]).filter(([, p]) => p);
  if (!jobs.length) return;
  jobs.forEach(([id, p]) => {
    if (!p.batch) clearTimeout(p.timer);
    ATT.pending.delete(id);
    ATT.saving.add(id);
    const row = ATT.rows.find(r => r.id === id);
    if (row) row.status = p.status;
  });
  renderAttendanceGrid();

  const results = await Promise.all(jobs.map(async ([id, p]) => {
    const row = ATT.rows.find(r => r.id === id);
    try {
      const res = await apiFetch(`${API_BASE}/attendance/mark`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ child_id: id, status: p.status }),
        keepalive: true,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      if (row) { row.status = data.status; row.time = data.check_in_time; }
      const child = STATE.children.find(c => c.id === id);
      if (child) { child.attendance = data.status; child.checkInTime = data.check_in_time; }
      return { ok: true, name: row?.name, notified: !!data.telegram_notified };
    } catch (err) {
      if (row) { row.status = p.prev.status; row.time = p.prev.time; }
      ATT.failed.set(id, { status: p.status, prev: p.prev });
      return { ok: false, name: row?.name };
    } finally {
      ATT.saving.delete(id);
    }
  }));
  renderAttendanceGrid();

  const failed = results.filter(r => !r.ok);
  const saved = results.filter(r => r.ok);
  const notified = saved.filter(r => r.notified);
  const unlinked = saved.length - notified.length;
  if (failed.length) {
    const who = failed.length === 1 ? failed[0].name : `${failed.length} ${t('common.child')}`;
    showToast(t('toast.attendanceSaveFailed', { who }), 'warning');
  }
  if (saved.length === 1) {
    showToast(notified.length
      ? t('toast.attendanceSavedNotified', { name: saved[0].name })
      : t('toast.attendanceSavedNotNotified', { name: saved[0].name }),
      notified.length ? 'success' : 'info');
  } else if (saved.length > 1) {
    showToast(t('toast.attendanceSavedBatch', { count: saved.length, notified: notified.length }) +
      (unlinked ? t('toast.attendanceSavedBatchUnlinked', { n: unlinked }) : '.'), 'success');
  }
}

function renderInvoicesTable() {
  const tbody = document.getElementById('invoicesTableBody');
  if (!tbody) return;
  tbody.innerHTML = STATE.children.map(c => `
    <tr>
      <td><code class="doc-code">INV-2026-10-${escapeHtml(c.id.toUpperCase())}</code></td>
      <td><b>${escapeHtml(c.name)}</b><br><small style="color: var(--text-muted);">${escapeHtml(c.group)}</small></td>
      <td>${escapeHtml(c.parentName)}</td>
      <td>${formatMoney(c.fee)}</td>
      <td class="${c.debt > 0 ? '' : 'text-amber'}">${signedMoney(c.debt > 0 ? 0 : -50000)}</td>
      <td class="text-emerald">${formatMoney(c.paid)}</td>
      <td class="${c.debt > 0 ? 'text-rose' : ''}"><b>${formatMoney(c.debt)}</b></td>
      <td>${c.debt === 0 ? `<span class="badge badge-emerald">${t('status.paid')}</span>` : `<span class="badge badge-rose">${t('billing.debtBadge')}</span>`}</td>
      <td class="text-right col-actions"><button class="btn btn-sm ${c.debt > 0 ? 'btn-primary' : 'btn-secondary'}" onclick="openRecordPaymentModal('${escapeHtml(c.id)}')">${t('billing.payBtn')}</button> <button class="btn btn-sm btn-secondary" onclick="viewChildReceipt('${escapeHtml(c.id)}')">${t('billing.receiptBtn')}</button></td>
    </tr>
  `).join('');
}

const PAYMENT = { childId: null, period: null, info: null, saving: false };

function todayPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function shiftPeriod(period, delta) {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function openRecordPaymentModal(childId) {
  PAYMENT.childId = childId;
  PAYMENT.period = todayPeriod();
  document.getElementById('paymentChildId').value = childId;
  document.getElementById('recordPaymentForm').reset();
  openModal('recordPaymentModal');
  loadPaymentInfo();
}

function shiftPaymentMonth(delta) {
  PAYMENT.period = shiftPeriod(PAYMENT.period, delta);
  loadPaymentInfo();
}

async function loadPaymentInfo() {
  const status = document.getElementById('paymentStatus');
  document.getElementById('paymentMonthLabel').textContent = periodLabel(PAYMENT.period);
  status.textContent = t('common.loading');
  status.dataset.state = '';
  try {
    const res = await apiFetch(`${API_BASE}/billing/child/${encodeURIComponent(PAYMENT.childId)}?period=${PAYMENT.period}`);
    const info = await res.json();
    if (!res.ok) throw new Error(info.detail || t('common.error'));
    PAYMENT.info = info;
    document.getElementById('paymentChildName').textContent = info.child;
    if (info.debt > 0) {
      status.dataset.state = info.overdue ? 'overdue' : 'debt';
      const [, dm, dd] = info.due_date.split('-').map(Number);
      const due = formatDayMonth(dd, dm);
      status.textContent = `${periodLabel(info.period)}: ${t('status.debt').toLowerCase()} ${formatMoney(info.debt)}` +
        (info.overdue ? ` · ${t('billing.overdueSince', { date: due })}` : ` · ${t('billing.dueOn', { date: due })}`);
    } else {
      status.dataset.state = 'ok';
      status.textContent = `${periodLabel(info.period)}: ${t('billing.noDebt')} ✓`;
    }
    const amount = info.debt > 0 ? info.debt : info.fee;
    document.getElementById('paymentAmount').value = amount || '';
    document.getElementById('paymentHint').textContent = info.debt > 0
      ? t('billing.willBeBilled', { period: periodLabel(info.period) })
      : (info.has_invoice ? t('billing.alreadyPaidExtra', { period: periodLabel(info.period) }) : t('billing.advanceBilled', { period: periodLabel(info.period) }));
    if (info.total_debt > info.debt) {
      document.getElementById('paymentHint').textContent += t('billing.otherMonthsDebt', { amount: formatMoney(info.total_debt - info.debt) });
    }
  } catch (err) {
    status.dataset.state = 'error';
    status.textContent = err.message || t('common.error');
  }
  updatePaymentSubmit();
}

function updatePaymentSubmit() {
  const btn = document.getElementById('paymentSubmit');
  const method = document.querySelector('input[name="paymentMethod"]:checked');
  const amount = parseFloat(document.getElementById('paymentAmount').value);
  btn.disabled = PAYMENT.saving || !method || !(amount > 0) || !PAYMENT.info;
  btn.textContent = PAYMENT.saving ? t('common.saving') : !method ? t('billing.payChooseMethod') : t('billing.paySubmit');
}

document.addEventListener('change', e => {
  if (e.target.name === 'paymentMethod') updatePaymentSubmit();
});
document.addEventListener('input', e => {
  if (e.target.id === 'paymentAmount') updatePaymentSubmit();
});

async function handleRecordPayment(e) {
  e.preventDefault();
  const method = document.querySelector('input[name="paymentMethod"]:checked')?.value;
  const amount = parseFloat(document.getElementById('paymentAmount').value);
  if (!method || !(amount > 0)) return;
  PAYMENT.saving = true;
  updatePaymentSubmit();
  try {
    const res = await apiFetch(`${API_BASE}/billing/record-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        child_id: PAYMENT.childId, amount, payment_method: method, period: PAYMENT.period,
        note: document.getElementById('paymentNote').value.trim() || null,
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || t('toast.genericError'));
    closeModal('recordPaymentModal');
    syncWithBackend();
    showToast(t('billing.payReceived', { amount: formatMoney(amount), period: periodLabel(data.period), advance: data.advance ? t('billing.advanceSuffix') : '' }), 'success');
  } catch (err) {
    showToast(err.message || t('toast.genericError'), 'warning');
  } finally {
    PAYMENT.saving = false;
    updatePaymentSubmit();
  }
}

function renderFinanceStats() {
  const container = document.getElementById('financeStatsGrid');
  if (!container) return;
  const s = STATE.financeStats;
  if (!s) { container.innerHTML = ''; return; }

  const rows = [
    { label: t('billing.incomeLabel.daily'), income: s.income.daily, expense: s.expenses.daily, net: s.net.daily, icon: 'color-emerald' },
    { label: t('billing.incomeLabel.monthly'), income: s.income.monthly, expense: s.expenses.monthly, net: s.net.monthly, icon: 'color-indigo' },
    { label: t('billing.incomeLabel.yearly'), income: s.income.yearly, expense: s.expenses.yearly, net: s.net.yearly, icon: 'color-amber' },
  ];

  container.innerHTML = rows.map(r => `
    <div class="stat-card">
      <div class="stat-info">
        <span class="stat-label">${r.label}</span>
        <p class="stat-value ${r.income ? 'text-emerald' : ''}">${signedMoney(r.income)}</p>
        <span class="stat-trend ${r.expense ? 'negative' : ''}">${t('billing.expenseLabel')} ${signedMoney(-r.expense)}</span>
        <span class="stat-trend ${r.net > 0 ? 'positive' : r.net < 0 ? 'negative' : ''}">${t('billing.netLabel')} ${signedMoney(r.net)}</span>
      </div>
    </div>
  `).join('');
}

// ============================================================================
// Xodimlar davomati (staff attendance)
// ============================================================================

const STAFF_ATT = { rows: [], editable: false, date: null, saving: new Set() };
const STAFF_ROLE_I18N = { TARBIYACHI: 'staff.role.tarbiyachi', ENAGA: 'staff.role.enaga', OSHPAZ: 'staff.role.oshpaz', HAMSHIRA: 'staff.role.hamshira' };

function staffRoleLabel(role) {
  return STAFF_ROLE_I18N[role] ? t(STAFF_ROLE_I18N[role]) : role.charAt(0) + role.slice(1).toLowerCase();
}

function initStaffAttendance() {
  const dateInput = document.getElementById('staffAttDate');
  if (dateInput) {
    dateInput.value = todayISO();
    dateInput.max = todayISO();
    dateInput.addEventListener('change', loadStaffAttendance);
  }
  document.getElementById('staffMonthInput')?.addEventListener('change', onStaffMonthChange);
  document.getElementById('staffAttList')?.addEventListener('click', e => {
    const btn = e.target.closest('.att-btn');
    const row = e.target.closest('.staff-att-row');
    if (btn && row) markStaffAttendance(row.dataset.id, btn.dataset.status);
  });
}

async function loadStaffAttendance() {
  try {
    const day = document.getElementById('staffAttDate')?.value || todayISO();
    const res = await apiFetch(`${API_BASE}/staff/attendance?att_date=${encodeURIComponent(day)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || t('common.error'));
    STAFF_ATT.rows = data.staff;
    STAFF_ATT.editable = data.editable;
    STAFF_ATT.date = data.date;
    const note = document.getElementById('staffAttPastNote');
    if (note) note.hidden = !(data.editable && data.date < todayISO());
    renderStaffAttendance();
  } catch (err) {
    document.getElementById('staffAttSummary').textContent = err.message || t('att.loadError');
  }
}

function renderStaffAttendance() {
  const list = document.getElementById('staffAttList');
  if (!list) return;
  const present = STAFF_ATT.rows.filter(r => r.status === 'PRESENT' || r.status === 'LATE').length;
  const unmarked = STAFF_ATT.rows.filter(r => !r.status).length;
  document.getElementById('staffAttSummary').textContent =
    `${present} / ${STAFF_ATT.rows.length} ${t('att.staffInShift')}` + (unmarked ? ` · ${unmarked} ${t('att.staffMarkedSuffix')}` : '');
  list.innerHTML = STAFF_ATT.rows.length ? STAFF_ATT.rows.map(r => {
    const meta = attStatusMeta(r.status);
    const role = staffRoleLabel(r.role);
    return `
      <div class="staff-att-row" data-id="${escapeHtml(r.id)}" data-status="${meta ? meta.cls : 'unmarked'}">
        <div class="staff-att-info">
          <b>${escapeHtml(r.name)}</b>
          <small>${escapeHtml(role)}${meta ? ` · ${meta.label}${r.check_in_time ? ' ' + r.check_in_time : ''}` : ''}</small>
        </div>
        <div class="staff-att-buttons" role="group" aria-label="${escapeHtml(r.name)}: ${t('att.ariaLabel')}">
          ${attStatuses().map(s => `<button type="button" class="att-btn" data-status="${s.key}" aria-pressed="${r.status === s.key}" ${STAFF_ATT.editable && !STAFF_ATT.saving.has(r.id) ? '' : 'disabled'}>${attMarkSvg(s.key)}<span>${s.label}</span></button>`).join('')}
        </div>
      </div>`;
  }).join('') : `<p class="att-empty">${t('att.staffEmpty')}</p>`;
}

async function markStaffAttendance(staffId, status) {
  const row = STAFF_ATT.rows.find(r => r.id === staffId);
  if (!row || !STAFF_ATT.editable || row.status === status) return;
  const prev = { status: row.status, time: row.check_in_time };
  row.status = status;
  STAFF_ATT.saving.add(staffId);
  renderStaffAttendance();
  try {
    const res = await apiFetch(`${API_BASE}/staff/attendance/mark`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staff_id: staffId, status, date: STAFF_ATT.date })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || t('common.error'));
    row.check_in_time = data.check_in_time;
    if (STAFF_ATT.date && STAFF_ATT.date.slice(0, 7) === staffMonth()) { loadStaffSheet(); reloadPayroll(); }
  } catch (err) {
    row.status = prev.status;
    row.check_in_time = prev.time;
    showToast(t('toast.staffAttSaveFailed', { name: row.name, error: err.message || '' }), 'warning');
  } finally {
    STAFF_ATT.saving.delete(staffId);
    renderStaffAttendance();
  }
}

// ============================================================================
// Ошхона харажатлари (weekly kitchen / food expense reports)
// ============================================================================

const KITCHEN = { reports: [], openId: null, editingId: null };

function initKitchen() {
  const form = document.getElementById('kitchenForm');
  if (!form) return;
  document.getElementById('kitchenAddRow')?.addEventListener('click', () => addKitchenRow());
  document.getElementById('kitchenItemRows')?.addEventListener('input', e => {
    if (e.target.classList.contains('kitchen-qty') || e.target.classList.contains('kitchen-price')) updateKitchenRowTotal(e.target.closest('.kitchen-item-row'));
  });
  document.getElementById('kitchenItemRows')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-remove-row]');
    if (!btn) return;
    const rows = document.getElementById('kitchenItemRows');
    if (rows.children.length > 1) { btn.closest('.kitchen-item-row').remove(); } else { clearKitchenRow(btn.closest('.kitchen-item-row')); }
    updateKitchenTotals();
  });
  form.addEventListener('submit', submitKitchenReport);
  document.getElementById('kitchenDeleteBtn')?.addEventListener('click', deleteKitchenReport);
  document.getElementById('kitchenEditBtn')?.addEventListener('click', editKitchenReport);
}

function clearKitchenRow(row) {
  row.querySelectorAll('input').forEach(i => { i.value = ''; });
  row.querySelector('.kitchen-row-total').textContent = '0';
}

function addKitchenRow(name = '', quantity = '', price = '') {
  const wrap = document.getElementById('kitchenItemRows');
  const row = document.createElement('div');
  row.className = 'kitchen-item-row';
  row.innerHTML = `
    <input type="text" class="custom-input kitchen-name" placeholder="Masalan: Ун" value="${escapeHtml(name)}">
    <input type="number" class="custom-input kitchen-qty" min="0" step="any" placeholder="0" value="${quantity}">
    <input type="number" class="custom-input kitchen-price" min="0" step="any" placeholder="0" value="${price}">
    <span class="kitchen-row-total">0</span>
    <button type="button" class="icon-button" data-remove-row aria-label="${t('common.delete')}">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>`;
  wrap.appendChild(row);
  updateKitchenRowTotal(row);
}

function updateKitchenRowTotal(row) {
  if (!row) return;
  const qty = parseFloat(row.querySelector('.kitchen-qty').value) || 0;
  const price = parseFloat(row.querySelector('.kitchen-price').value) || 0;
  row.querySelector('.kitchen-row-total').textContent = new Intl.NumberFormat('uz-UZ').format(qty * price);
  updateKitchenTotals();
}

function updateKitchenTotals() {
  let total = 0;
  document.querySelectorAll('#kitchenItemRows .kitchen-item-row').forEach(row => {
    total += (parseFloat(row.querySelector('.kitchen-qty').value) || 0) * (parseFloat(row.querySelector('.kitchen-price').value) || 0);
  });
  const count = parseInt(document.getElementById('kitchenChildCount').value, 10) || 0;
  document.getElementById('kitchenTotalAmount').textContent = formatMoney(total);
  document.getElementById('kitchenPerChild').textContent = count > 0 ? formatMoney(total / count) : '—';
}

function openKitchenForm(report = null) {
  KITCHEN.editingId = report ? report.id : null;
  document.getElementById('kitchenFormTitle').textContent = report ? t('kitchen.form.editTitle') : t('kitchen.form.newTitle');
  document.getElementById('kitchenSubmitBtn').textContent = t('common.save');
  document.getElementById('kitchenForm').reset();
  document.getElementById('kitchenItemRows').innerHTML = '';
  if (report) {
    document.getElementById('kitchenWeekStart').value = report.week_start;
    document.getElementById('kitchenWeekEnd').value = report.week_end;
    document.getElementById('kitchenChildCount').value = report.child_count;
    report.items.forEach(it => addKitchenRow(it.name, it.quantity, it.unit_price));
  } else {
    for (let i = 0; i < 5; i++) addKitchenRow();
  }
  updateKitchenTotals();
  openModal('kitchenFormModal');
}

async function editKitchenReport() {
  if (!KITCHEN.openId) return;
  const res = await apiFetch(`${API_BASE}/kitchen/reports/${encodeURIComponent(KITCHEN.openId)}`);
  const data = await res.json();
  if (!res.ok) return showToast(data.detail || t('kitchen.loadFailed'), 'warning');
  closeModal('kitchenDetailModal');
  openKitchenForm(data);
}

document.addEventListener('input', e => { if (e.target.id === 'kitchenChildCount') updateKitchenTotals(); });

async function submitKitchenReport(e) {
  e.preventDefault();
  const items = [...document.querySelectorAll('#kitchenItemRows .kitchen-item-row')]
    .map(row => ({
      name: row.querySelector('.kitchen-name').value.trim(),
      quantity: parseFloat(row.querySelector('.kitchen-qty').value),
      unit_price: parseFloat(row.querySelector('.kitchen-price').value),
    }))
    .filter(it => it.name && it.quantity > 0 && !isNaN(it.unit_price));

  if (!items.length) return showToast(t('kitchen.atLeastOneItem'), 'warning');

  const body = {
    week_start: document.getElementById('kitchenWeekStart').value,
    week_end: document.getElementById('kitchenWeekEnd').value,
    child_count: parseInt(document.getElementById('kitchenChildCount').value, 10),
    items,
  };
  const btn = document.getElementById('kitchenSubmitBtn');
  btn.disabled = true;
  const editingId = KITCHEN.editingId;
  try {
    const res = await apiFetch(editingId ? `${API_BASE}/kitchen/reports/${encodeURIComponent(editingId)}` : `${API_BASE}/kitchen/reports`, {
      method: editingId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(Array.isArray(data.detail) ? t('kitchen.incompleteData') : (data.detail || t('common.error')));
    closeModal('kitchenFormModal');
    showToast(t('kitchen.saved', { total: formatMoney(data.total_amount), perChild: formatMoney(data.cost_per_child) }), 'success');
    loadKitchenReports();
  } catch (err) {
    showToast(err.message, 'warning');
  } finally {
    btn.disabled = false;
  }
}

// ============================================================================
// Sozlamalar (Settings): tashkilot ma'lumotlarini saqlash
// ============================================================================
async function saveOrgSettings() {
  const body = {
    name: document.getElementById('settingsOrgName').value.trim(),
    phone: document.getElementById('settingsOrgPhone').value.trim(),
    address: document.getElementById('settingsOrgAddress').value.trim() || null,
  };
  if (!body.name) return showToast(t('settings.orgNameRequired'), 'warning');

  try {
    const res = await apiFetch(`${API_BASE}/settings/org`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(Array.isArray(data.detail) ? t('kitchen.incompleteData') : (data.detail || t('common.error')));
    showToast(t('settings.saved'), 'success');
    await initUserSession();
    if (can('audit.view')) loadAuditLog();
  } catch (err) {
    showToast(err.message, 'warning');
  }
}

// ============================================================================
// Sozlamalar (Settings): O'zgarishlar tarixi (audit trail) — faqat boshqaruv
// ============================================================================
const AUDIT_FIELD_LABELS = {
  monthly_fee: 'audit.field.monthlyFee', discount: 'audit.field.discount', note: 'audit.field.note',
  allergies: 'audit.field.allergies', week_start: 'audit.field.weekStart', week_end: 'audit.field.weekEnd',
  child_count: 'audit.field.childCount', total_amount: 'audit.field.totalAmount', amount: 'audit.field.amount',
  status: 'audit.field.status', role: 'audit.field.role', base_salary: 'audit.field.baseSalary', name: 'settings.orgName', phone: 'settings.orgPhone', address: 'settings.orgAddress',
  late_penalty_pct: 'audit.field.latePenaltyPct', deduction_start: 'audit.field.deductionStart', holidays: 'audit.field.holidays', deduction: 'audit.field.deduction',
};

function formatAuditValue(value, field) {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'late_penalty_pct') return `${value}%`;
  if (field === 'status') return escapeHtml(attStatusMeta(value)?.label || String(value));
  if (typeof value === 'number') return formatMoney(value);
  return escapeHtml(String(value));
}

function renderAuditChanges(changes) {
  if (!changes || !Object.keys(changes).length) return '—';
  return `<ul class="audit-changes-list">${Object.entries(changes).map(([field, { old, new: next }]) => {
    const label = AUDIT_FIELD_LABELS[field] ? t(AUDIT_FIELD_LABELS[field]) : escapeHtml(field);
    return `<li><b>${label}:</b> ${formatAuditValue(old, field)} → ${formatAuditValue(next, field)}</li>`;
  }).join('')}</ul>`;
}

function formatAuditWhen(createdAt) {
  // SQLite's CURRENT_TIMESTAMP: "YYYY-MM-DD HH:MM:SS"
  const [datePart, timePart] = (createdAt || '').split(' ');
  const [y, m, d] = (datePart || '').split('-').map(Number);
  if (!y || !m || !d) return createdAt || '—';
  return `${formatDayMonth(d, m)}, ${(timePart || '').slice(0, 5)}`;
}

async function loadAuditLog() {
  try {
    const res = await apiFetch(`${API_BASE}/audit/log?limit=100`);
    if (!res.ok) return;
    STATE.auditLog = await res.json();
    renderAuditLog();
  } catch (e) {}
}

function renderAuditLog() {
  const body = document.getElementById('auditLogBody');
  if (!body) return;
  const rows = STATE.auditLog || [];
  document.getElementById('auditLogEmpty').style.display = rows.length ? 'none' : 'block';
  body.innerHTML = rows.map(entry => `
    <tr>
      <td>${formatAuditWhen(entry.created_at)}</td>
      <td>${escapeHtml(entry.actor_name)} <span class="text-muted">(${roleTitle(entry.actor_role)})</span></td>
      <td>${t(`audit.action.${entry.action}`) === `audit.action.${entry.action}` ? escapeHtml(entry.action) : t(`audit.action.${entry.action}`)}</td>
      <td>${escapeHtml(entry.target_label || entry.target_id || '—')}</td>
      <td>${renderAuditChanges(entry.changes)}</td>
    </tr>
  `).join('');
}

function formatDateUz(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return formatDayMonth(d, m);
}

async function loadKitchenReports() {
  const list = document.getElementById('kitchenList');
  if (!list) return;
  list.innerHTML = `<p class="att-empty">${t('common.loading')}</p>`;
  try {
    const res = await apiFetch(`${API_BASE}/kitchen/reports`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || t('common.error'));
    KITCHEN.reports = data;
    renderKitchenList();
  } catch (err) {
    list.innerHTML = `<div class="att-empty"><p>${escapeHtml(err.message || t('kitchen.loadFailed'))}</p></div>`;
  }
}

function renderKitchenList() {
  const list = document.getElementById('kitchenList');
  if (!KITCHEN.reports.length) {
    list.innerHTML = `<p class="att-empty">${t('kitchen.empty')}</p>`;
    return;
  }
  const latest = KITCHEN.reports[0];
  const prev = KITCHEN.reports[1];
  const trend = prev ? latest.cost_per_child - prev.cost_per_child : null;
  list.innerHTML = `
    <div class="kitchen-summary">
      <div><span>${t('kitchen.lastWeek')}</span><b>${escapeHtml(formatDateUz(latest.week_start))} – ${escapeHtml(formatDateUz(latest.week_end))}</b></div>
      <div><span>${t('kitchen.perChild')}</span><b>${formatMoney(latest.cost_per_child)}</b>${trend !== null ? `<small class="${trend > 0 ? 'text-rose' : trend < 0 ? 'text-emerald' : ''}">${trend > 0 ? '+' : ''}${formatMoney(trend)} ${t('kitchen.vsLastWeek')}</small>` : ''}</div>
      <div><span>${t('kitchen.totalExpense')}</span><b>${formatMoney(latest.total_amount)}</b></div>
    </div>
    <div class="kitchen-history">${KITCHEN.reports.map(r => `
      <button type="button" class="kitchen-history-row" onclick="openKitchenDetail('${escapeHtml(r.id)}')">
        <span class="kitchen-history-week">${escapeHtml(formatDateUz(r.week_start))} – ${escapeHtml(formatDateUz(r.week_end))}</span>
        <span class="kitchen-history-count">${r.child_count} ${t('common.child')}</span>
        <span class="kitchen-history-total">${formatMoney(r.total_amount)}</span>
        <span class="kitchen-history-per">${formatMoney(r.cost_per_child)} ${t('kitchen.perChildSuffix')}</span>
        <svg class="todo-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
      </button>`).join('')}</div>`;
}

async function openKitchenDetail(reportId) {
  KITCHEN.openId = reportId;
  document.getElementById('kitchenDetailItems').innerHTML = '';
  document.getElementById('kitchenDetailSummary').textContent = t('common.loading');
  openModal('kitchenDetailModal');
  try {
    const res = await apiFetch(`${API_BASE}/kitchen/reports/${encodeURIComponent(reportId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || t('common.error'));
    document.getElementById('kitchenDetailTitle').textContent = `${formatDateUz(data.week_start)} – ${formatDateUz(data.week_end)}`;
    document.getElementById('kitchenDetailSummary').textContent =
      `${data.child_count} ${t('common.child')} · ${t('kitchen.totalExpense')} ${formatMoney(data.total_amount)} · ${t('kitchen.perChild')} ${formatMoney(data.cost_per_child)}`;
    document.getElementById('kitchenDetailItems').innerHTML = data.items.map((it, i) => `
      <tr><td>${i + 1}</td><td>${escapeHtml(it.name)}</td><td>${it.quantity}</td><td>${formatMoney(it.unit_price)}</td><td class="text-right">${formatMoney(it.line_total)}</td></tr>
    `).join('');
  } catch (err) {
    document.getElementById('kitchenDetailSummary').textContent = err.message || t('kitchen.loadFailed');
  }
}

async function deleteKitchenReport() {
  if (!KITCHEN.openId) return;
  if (!confirm(t('confirm.deleteKitchen'))) return;
  try {
    const res = await apiFetch(`${API_BASE}/kitchen/reports/${encodeURIComponent(KITCHEN.openId)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || t('common.error'));
    closeModal('kitchenDetailModal');
    showToast(t('kitchen.deleted'), 'info');
    loadKitchenReports();
  } catch (err) {
    showToast(err.message, 'warning');
  }
}

// ============================================================================
// Avtomatik to'lov eslatmalari (automatic debt reminders)
// ============================================================================

const REMINDERS = { settings: null, maxTimes: 6, fields: [] };
const REMINDER_SAMPLE = { childName: 'Imron Rahimov', parentName: 'Xurshid aka', amount: "1 850 000 so'm", dueDate: '10-noyabr', group: 'Yulduzcha' };

function reminderFieldLabel(field) {
  return t(`reminder.field.${field}`);
}

function initReminders() {
  const form = document.getElementById('reminderForm');
  if (!form) return;
  form.addEventListener('submit', saveReminders);
  form.addEventListener('click', e => {
    const step = e.target.closest('[data-step]');
    if (step) {
      const [id, delta] = step.dataset.step.split(':');
      const el = document.getElementById(id);
      const limit = id === 'remBefore' ? 30 : 60;
      el.textContent = Math.max(0, Math.min(limit, Number(el.textContent) + Number(delta)));
      updateReminderWindow();
    }
    const remove = e.target.closest('[data-remove-time]');
    if (remove) {
      REMINDERS.settings.times = REMINDERS.settings.times.filter(t => t !== remove.dataset.removeTime);
      renderReminderTimes();
    }
    const field = e.target.closest('[data-field]');
    if (field) {
      const area = document.getElementById('remTemplate');
      const token = `{${field.dataset.field}}`;
      const pos = area.selectionStart ?? area.value.length;
      area.value = area.value.slice(0, pos) + token + area.value.slice(area.selectionEnd ?? pos);
      area.focus();
      area.selectionStart = area.selectionEnd = pos + token.length;
      renderReminderPreview();
    }
  });
  document.getElementById('remTimeAdd').addEventListener('click', () => {
    const value = document.getElementById('remTimeInput').value;
    const times = REMINDERS.settings.times;
    if (!value) return;
    if (times.includes(value)) return showToast(t('billing.addTimeExists'), 'info');
    if (times.length >= REMINDERS.maxTimes) return showToast(t('billing.addTimeLimit', { max: REMINDERS.maxTimes }), 'warning');
    times.push(value);
    times.sort();
    renderReminderTimes();
  });
  document.getElementById('remTemplate').addEventListener('input', renderReminderPreview);
  document.getElementById('remEnabled').addEventListener('change', updateReminderWindow);
  document.getElementById('remSendNow').addEventListener('click', sendDebtReminders);
}

async function loadReminders() {
  try {
    const res = await apiFetch(`${API_BASE}/billing/reminders`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || t('common.error'));
    REMINDERS.settings = { ...data.settings, times: [...data.settings.times] };
    REMINDERS.maxTimes = data.max_times;
    REMINDERS.fields = data.fields;
    document.getElementById('remEnabled').checked = data.settings.enabled;
    document.getElementById('remBefore').textContent = data.settings.days_before;
    document.getElementById('remAfter').textContent = data.settings.days_after;
    document.getElementById('remTemplate').value = data.settings.template;
    document.getElementById('remFields').innerHTML = data.fields.map(f =>
      `<button type="button" class="field-chip" data-field="${f}">+ ${reminderFieldLabel(f)}</button>`).join('');
    renderReminderStats(data.stats);
    renderReminderTimes();
    renderReminderPreview();
    updateReminderWindow();
  } catch (err) {
    showToast(err.message || t('billing.statLoadFailed'), 'warning');
  }
}

function renderReminderStats(stats) {
  document.getElementById('remDueSoon').textContent = stats.due_soon;
  document.getElementById('remOverdue').textContent = stats.overdue;
  document.getElementById('remLinked').textContent = stats.linked;
  document.getElementById('remTotal').textContent = new Intl.NumberFormat('uz-UZ').format(stats.total_left || 0);
}

function updateReminderWindow() {
  const on = document.getElementById('remEnabled').checked;
  const status = document.getElementById('remStatus');
  status.textContent = on ? t('status.enabled') : t('status.disabled');
  status.className = on ? 'text-emerald' : '';
  document.getElementById('remWindow').textContent =
    `${document.getElementById('remBefore').textContent} ${t('billing.stepper.before').toLowerCase()} · ${document.getElementById('remAfter').textContent} ${t('billing.stepper.after').toLowerCase()}`;
}

function renderReminderTimes() {
  document.getElementById('remTimes').innerHTML = REMINDERS.settings.times.map(time => `
    <span class="time-chip">${time}<button type="button" data-remove-time="${time}" aria-label="${time}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></span>`).join('')
    || `<span class="reminder-help">${t('billing.noTimes')}</span>`;
}

function renderReminderPreview() {
  let text = document.getElementById('remTemplate').value;
  Object.entries(REMINDER_SAMPLE).forEach(([k, v]) => { text = text.split(`{${k}}`).join(v); });
  document.getElementById('remPreview').textContent = text ? t('billing.preview', { text }) : '';
}

async function saveReminders(e) {
  e.preventDefault();
  const body = {
    enabled: document.getElementById('remEnabled').checked,
    days_before: Number(document.getElementById('remBefore').textContent),
    days_after: Number(document.getElementById('remAfter').textContent),
    times: REMINDERS.settings.times,
    template: document.getElementById('remTemplate').value.trim(),
  };
  try {
    const res = await apiFetch(`${API_BASE}/billing/reminders`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(Array.isArray(data.detail) ? t('kitchen.incompleteData') : (data.detail || t('common.error')));
    REMINDERS.settings = { ...data.settings, times: [...data.settings.times] };
    renderReminderStats(data.stats);
    renderReminderTimes();
    showToast(body.enabled ? t('billing.settingsSaved.on') : t('billing.settingsSaved.off'), 'success');
  } catch (err) {
    showToast(err.message, 'warning');
  }
}

async function sendDebtReminders() {
  if (!confirm(t('confirm.sendReminders'))) return;
  try {
    const res = await apiFetch(`${API_BASE}/billing/remind-debtors`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || t('common.error'));
    showToast(data.targets
      ? t('billing.sentToParents', { sent: data.sent }) + (data.unlinked ? t('billing.someUnlinked', { n: data.unlinked }) : '')
      : t('billing.noDebtorsNow'), data.sent ? 'success' : 'info');
  } catch (err) {
    showToast(err.message || t('billing.remindFailed'), 'warning');
  }
}

function updateTmaSimulator() {
  const select = document.getElementById('tmaChildSelect');
  if (!select) return;
  const index = parseInt(select.value) || 0;
  const child = STATE.children[index] || STATE.children[0];
  if (!child) return;

  document.getElementById('tmaChildAvatar').innerText = child.name.split(' ').map(n => n[0]).join('');
  document.getElementById('tmaChildName').innerText = child.name;
  document.getElementById('tmaChildGroup').innerText = `${child.group} ${t('tma.groupSuffix')}`;
  document.getElementById('tmaCheckInTime').innerText = child.checkInTime ? `${child.checkInTime} ${t('tma.atSuffix')}`.trim() : t('tma.notArrived');
  document.getElementById('tmaPaymentAmount').innerText = formatMoney(child.fee);
}

function triggerSimulatedTelegramAlert() {
  const select = document.getElementById('tmaChildSelect');
  const index = parseInt(select.value) || 0;
  const child = STATE.children[index] || STATE.children[0];
  showToast(t('tma.testAlertSent', { parent: child.parentName }), 'success');
}

function openModal(id) { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }

function viewChildReceipt(childId) {
  const child = STATE.children.find(c => c.id === childId) || STATE.children[0];
  if (!child) return;
  document.getElementById('receiptChildName').innerText = child.name;
  document.getElementById('receiptGroupName').innerText = child.group;
  document.getElementById('receiptAmount').innerText = formatMoney(child.paid || child.fee);
  document.getElementById('receiptInvoiceCode').innerText = `INV-2026-10-${child.id.toUpperCase()}`;
  openModal('receiptModal');
}

function handleChildSubmit(e) {
  e.preventDefault();
  const firstName = document.getElementById('newChildFirstName').value.trim();
  const lastName = document.getElementById('newChildLastName').value.trim();
  const birthDate = document.getElementById('newChildBirthDate').value;
  const group = document.getElementById('newChildGroup').value;
  const parentName = document.getElementById('newChildParentName').value.trim();
  const parentPhone = document.getElementById('newChildParentPhone').value.trim();
  // Stored data stays Uzbek regardless of UI language, like the rest of the database's content.
  const allergies = document.getElementById('newChildAllergies').value.trim() || 'Yo\'q';

  apiFetch(`${API_BASE}/children`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      first_name: firstName,
      last_name: lastName,
      birth_date: birthDate,
      group_name: group,
      parent_name: parentName,
      parent_phone: parentPhone,
      allergies: allergies
    })
  }).then(r => r.json()).then(() => {
    closeModal('addChildModal');
    syncWithBackend();
    showToast(t('modal.addChild.saved', { name: `${firstName} ${lastName}` }), 'success');
  }).catch(() => {
    closeModal('addChildModal');
    syncWithBackend();
    showToast(t('modal.addChild.savedFallback'), 'success');
  });
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const text = document.createElement('span');
  text.textContent = message;
  toast.appendChild(text);
  container.appendChild(toast);
  setTimeout(() => dismissToast(toast), 4500);
}

function dismissToast(toast) {
  if (!toast.isConnected) return;
  toast.style.animation = 'slideInRight 0.3s ease reverse';
  setTimeout(() => toast.remove(), 280);
}

function showActionToast(message, actionLabel, onAction, durationMs) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast toast-success';
  toast.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = message;
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'toast-action';
  action.textContent = actionLabel;
  action.addEventListener('click', () => { onAction(); dismissToast(toast); });
  toast.append(text, action);
  container.appendChild(toast);
  setTimeout(() => dismissToast(toast), durationMs);
}

function formatMoney(amount) {
  return new Intl.NumberFormat('uz-UZ').format(amount || 0) + ' UZS';
}

function signedMoney(amount) {
  if (!amount) return formatMoney(0);
  return (amount > 0 ? '+' : '−') + formatMoney(Math.abs(amount));
}

function handleGlobalSearch(query) {
  if (!query) return;
  const q = query.toLowerCase();
  const found = STATE.children.find(c => c.name.toLowerCase().includes(q));
  if (found) {
    switchTab('children');
    const filterInput = document.getElementById('childSearchFilter');
    if (filterInput) {
      filterInput.value = query;
      renderChildrenTable();
    }
  }
}

// ============================================================================
// Moliyaviy hisobotlar (monthly revenue, past-period debts, payment history)
// ============================================================================

const REPORTS = { revenue: null, period: null, years: null, inited: false, periodSeq: 0 };

function payMethodLabel(method) {
  const key = `billing.payMethod.${String(method || '').toLowerCase()}`;
  const label = t(key);
  return label === key ? (method || '—') : label;
}

function formatPaidAt(paidAt) {
  if (!paidAt) return '—';
  const [datePart, timePart] = paidAt.split(' ');
  const [y, m, d] = datePart.split('-').map(Number);
  if (!y || !m || !d) return paidAt;
  return `${formatDayMonth(d, m)} ${y}${timePart ? ', ' + timePart.slice(0, 5) : ''}`;
}

function periodLabel(period) {
  const [y, m] = period.split('-').map(Number);
  return `${t('month.' + m)} ${y}`;
}

function initReports() {
  if (REPORTS.inited) return;
  REPORTS.inited = true;
  document.getElementById('reportsYearSelect')?.addEventListener('change', loadRevenueReport);
  document.getElementById('reportsPeriodInput')?.addEventListener('change', loadPeriodReport);
  document.getElementById('reportsGroupSelect')?.addEventListener('change', loadPeriodReport);
  document.getElementById('reportsOnlyDebtors')?.addEventListener('change', loadPeriodReport);
  document.getElementById('reportsSearch')?.addEventListener('input', renderPeriodReport);
  const periodInput = document.getElementById('reportsPeriodInput');
  if (periodInput) {
    periodInput.value = todayISO().slice(0, 7);
    periodInput.max = todayISO().slice(0, 7);
  }
}

async function loadReports() {
  if (!can('finance.reports')) return;
  initReports();
  const yearSel = document.getElementById('reportsYearSelect');
  if (yearSel && !REPORTS.years) {
    try {
      const res = await apiFetch(`${API_BASE}/reports/years`);
      REPORTS.years = res.ok ? await res.json() : [new Date().getFullYear()];
    } catch (_) {
      REPORTS.years = [new Date().getFullYear()];
    }
    yearSel.innerHTML = REPORTS.years.map(y => `<option value="${y}">${y}</option>`).join('');
    yearSel.value = String(new Date().getFullYear());
  }
  const groupSel = document.getElementById('reportsGroupSelect');
  if (groupSel) {
    const prev = groupSel.value || 'ALL';
    groupSel.innerHTML = `<option value="ALL">${t('common.all')}</option>` +
      STATE.groups.map(g => `<option value="${escapeHtml(g.name)}">${escapeHtml(g.name)}</option>`).join('');
    groupSel.value = [...groupSel.options].some(o => o.value === prev) ? prev : 'ALL';
  }
  loadRevenueReport();
  loadPeriodReport();
}

async function loadRevenueReport() {
  const year = document.getElementById('reportsYearSelect')?.value || new Date().getFullYear();
  try {
    const res = await apiFetch(`${API_BASE}/reports/revenue?year=${encodeURIComponent(year)}`);
    if (!res.ok) throw new Error(res.status);
    REPORTS.revenue = await res.json();
  } catch (_) {
    REPORTS.revenue = null;
  }
  renderRevenueReport();
}

function reportKpis(items) {
  return items.map(([label, value, cls]) =>
    `<div class="reports-kpi"><span>${label}</span><b class="${cls || ''}">${value}</b></div>`).join('');
}

function renderRevenueReport() {
  const body = document.getElementById('reportsRevenueBody');
  const kpis = document.getElementById('reportsYearKpis');
  if (!body) return;
  const data = REPORTS.revenue;
  if (!data) {
    body.innerHTML = `<tr><td colspan="7" class="text-muted">${t('reports.loadError')}</td></tr>`;
    if (kpis) kpis.innerHTML = '';
    return;
  }
  const tot = data.totals;
  if (kpis) {
    kpis.innerHTML = reportKpis([
      [t('reports.kpi.yearReceived', { year: data.year }), formatMoney(tot.received), 'text-emerald'],
      [t('reports.kpi.yearBilled'), formatMoney(tot.billed)],
      [t('reports.kpi.yearDebt'), formatMoney(tot.debt), tot.debt ? 'text-rose' : ''],
      [t('reports.kpi.payments'), String(tot.payments)],
    ]);
  }
  const max = Math.max(1, ...data.months.map(m => m.received));
  const nowPeriod = todayISO().slice(0, 7);
  body.innerHTML = data.months.map(m => {
    const future = m.period > nowPeriod;
    const empty = !m.received && !m.billed;
    const methods = Object.entries(m.methods).map(([k, v]) => `${payMethodLabel(k)}: ${formatMoney(v)}`).join('\n');
    const pct = m.collection_percent;
    return `
      <tr class="${future ? 'is-future' : ''}">
        <td><b>${t('month.' + m.month)}</b></td>
        <td title="${escapeHtml(methods)}">
          <div class="reports-bar-cell">
            <span class="reports-bar" style="width:${Math.round(m.received / max * 100)}%"></span>
            <b class="${m.received ? 'text-emerald' : 'text-muted'}">${formatMoney(m.received)}</b>
          </div>
          ${m.payments ? `<small class="text-muted">${t('reports.paymentsCount', { n: m.payments })}</small>` : ''}
        </td>
        <td>${m.billed ? formatMoney(m.billed) : '<span class="text-muted">—</span>'}</td>
        <td>${m.billed ? formatMoney(m.billed_paid) : '<span class="text-muted">—</span>'}</td>
        <td>${m.debt ? `<b class="text-rose">${formatMoney(m.debt)}</b><br><small class="text-muted">${t('reports.debtorsCount', { n: m.debtors })}</small>` : '<span class="text-muted">—</span>'}</td>
        <td>${pct === null ? '<span class="text-muted">—</span>' : `<span class="badge ${pct >= 90 ? 'badge-emerald' : pct >= 60 ? 'badge-amber' : 'badge-rose'}">${pct}%</span>`}</td>
        <td class="text-right">${empty ? '' : `<button type="button" class="btn btn-sm btn-secondary" onclick="openReportPeriod('${m.period}')">${t('reports.open')}</button>`}</td>
      </tr>`;
  }).join('') + `
      <tr class="reports-total-row">
        <td><b>${t('reports.total')}</b></td>
        <td><b class="text-emerald">${formatMoney(tot.received)}</b></td>
        <td><b>${formatMoney(tot.billed)}</b></td>
        <td><b>${formatMoney(tot.billed_paid)}</b></td>
        <td><b class="${tot.debt ? 'text-rose' : ''}">${formatMoney(tot.debt)}</b></td>
        <td colspan="2"></td>
      </tr>`;
}

function openReportPeriod(period) {
  const input = document.getElementById('reportsPeriodInput');
  if (!input) return;
  input.value = period;
  loadPeriodReport();
  document.getElementById('reportsPeriodCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadPeriodReport() {
  const period = document.getElementById('reportsPeriodInput')?.value || todayISO().slice(0, 7);
  const group = encodeURIComponent(document.getElementById('reportsGroupSelect')?.value || 'ALL');
  const onlyDebtors = document.getElementById('reportsOnlyDebtors')?.checked ? 'true' : 'false';
  const seq = ++REPORTS.periodSeq;
  try {
    const res = await apiFetch(`${API_BASE}/reports/period?period=${encodeURIComponent(period)}&group_name=${group}&only_debtors=${onlyDebtors}`);
    if (seq !== REPORTS.periodSeq) return;
    if (!res.ok) throw new Error(res.status);
    REPORTS.period = await res.json();
  } catch (_) {
    if (seq !== REPORTS.periodSeq) return;
    REPORTS.period = null;
  }
  renderPeriodReport();
}

function renderPeriodReport() {
  const body = document.getElementById('reportsPeriodBody');
  const kpis = document.getElementById('reportsPeriodKpis');
  if (!body) return;
  const data = REPORTS.period;
  if (!data) {
    body.innerHTML = `<tr><td colspan="7" class="text-muted">${t('reports.loadError')}</td></tr>`;
    if (kpis) kpis.innerHTML = '';
    return;
  }
  const tot = data.totals;
  if (kpis) {
    kpis.innerHTML = reportKpis([
      [t('reports.kpi.periodDue', { period: periodLabel(data.period) }), formatMoney(tot.due)],
      [t('reports.kpi.periodPaid'), formatMoney(tot.paid), 'text-emerald'],
      [t('reports.kpi.periodDebt'), formatMoney(tot.debt), tot.debt ? 'text-rose' : ''],
      [t('reports.kpi.debtors'), `${tot.debtors} / ${tot.children}`],
    ]);
  }
  const q = (document.getElementById('reportsSearch')?.value || '').trim().toLowerCase();
  const rows = q
    ? data.rows.filter(r => `${r.name} ${r.parent_name || ''} ${r.parent_phone || ''}`.toLowerCase().includes(q))
    : data.rows;
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7" class="text-muted">${t(data.rows.length ? 'reports.noMatch' : 'reports.noInvoices')}</td></tr>`;
    return;
  }
  body.innerHTML = rows.map(r => {
    const status = r.debt === 0
      ? `<span class="badge badge-emerald">${t('status.paid')}</span>`
      : r.overdue
        ? `<span class="badge badge-rose">${t('reports.status.overdue')}</span>`
        : `<span class="badge badge-amber">${t('reports.status.unpaid')}</span>`;
    return `
      <tr>
        <td>
          <button type="button" class="link-button" onclick="openChildHistory('${escapeHtml(r.child_id)}')"><b>${escapeHtml(r.name)}</b></button>
          ${r.child_active ? '' : ` <span class="badge badge-slate">${t('reports.leftChild')}</span>`}
          <br><small class="text-muted">${escapeHtml(r.group_name)}</small>
        </td>
        <td>${escapeHtml(r.parent_name || '—')}<br><small class="text-muted">${escapeHtml(r.parent_phone || '')}</small></td>
        <td>${formatMoney(r.amount_due)}</td>
        <td class="${r.amount_paid ? 'text-emerald' : ''}">${formatMoney(r.amount_paid)}</td>
        <td>${r.debt ? `<b class="text-rose">${formatMoney(r.debt)}</b>` : formatMoney(0)}</td>
        <td>${formatPaidAt(r.last_paid_at)}</td>
        <td>${status}</td>
      </tr>`;
  }).join('');
}

async function openChildHistory(childId) {
  const body = document.getElementById('childHistoryBody');
  const title = document.getElementById('childHistoryTitle');
  if (!body) return;
  body.innerHTML = `<p class="text-muted">${t('common.loading')}</p>`;
  openModal('childHistoryModal');
  try {
    const res = await apiFetch(`${API_BASE}/reports/child/${encodeURIComponent(childId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || t('reports.loadError'));
    if (title) title.textContent = `${t('reports.historyTitle')}: ${data.child.name}`;
    body.innerHTML = renderChildHistory(data);
  } catch (err) {
    body.innerHTML = `<p class="text-rose">${escapeHtml(err.message || t('reports.loadError'))}</p>`;
  }
}

function renderChildHistory(data) {
  const c = data.child;
  const tot = data.totals;
  const head = `
    <p class="text-muted">${escapeHtml(c.group_name)} · ${escapeHtml(c.parent_name || '')} ${escapeHtml(c.parent_phone || '')}${c.active ? '' : ` · <span class="badge badge-slate">${t('reports.leftChild')}</span>`}</p>
    <div class="reports-kpis">${reportKpis([
      [t('reports.kpi.allDue'), formatMoney(tot.due)],
      [t('reports.kpi.allPaid'), formatMoney(tot.paid), 'text-emerald'],
      [t('reports.kpi.allDebt'), formatMoney(tot.debt), tot.debt ? 'text-rose' : ''],
    ])}</div>`;
  if (!data.periods.length) return head + `<p class="text-muted">${t('reports.noHistory')}</p>`;
  const rows = data.periods.map(p => {
    const status = p.debt === 0
      ? `<span class="badge badge-emerald">${t('status.paid')}</span>`
      : `<span class="badge ${p.overdue ? 'badge-rose' : 'badge-amber'}">${t(p.overdue ? 'reports.status.overdue' : 'reports.status.unpaid')}</span>`;
    const payments = p.payments.length
      ? `<ul class="history-payments">${p.payments.map(pay => `
          <li>
            <b class="text-emerald">${formatMoney(pay.amount)}</b>
            · ${payMethodLabel(pay.method)} · ${formatPaidAt(pay.paid_at)}
            ${pay.recorded_by ? `<small class="text-muted">· ${escapeHtml(pay.recorded_by)}</small>` : ''}
            ${pay.note ? `<br><small class="text-muted">${escapeHtml(pay.note)}</small>` : ''}
          </li>`).join('')}</ul>`
      : `<small class="text-muted">${t('reports.noPayments')}</small>`;
    return `
      <tr>
        <td><b>${periodLabel(p.period)}</b></td>
        <td>${formatMoney(p.amount_due)}</td>
        <td>${formatMoney(p.amount_paid)}</td>
        <td>${p.debt ? `<b class="text-rose">${formatMoney(p.debt)}</b>` : formatMoney(0)}</td>
        <td>${status}</td>
        <td>${payments}</td>
      </tr>`;
  }).join('');
  return head + `
    <div class="table-responsive">
      <table class="data-table">
        <thead><tr>
          <th>${t('reports.th.month')}</th><th>${t('reports.th.due')}</th><th>${t('billing.th.paid')}</th>
          <th>${t('reports.th.debt')}</th><th>${t('billing.th.status')}</th><th>${t('reports.th.payments')}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}
