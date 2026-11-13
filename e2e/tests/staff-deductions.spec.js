const { test, expect } = require('@playwright/test');
const { loginAs } = require('../helpers');

function previousMonth() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function deductionCell(row) {
  return row.locator('td').nth(5);
}

test('unmarked days are not deducted automatically', async ({ page }) => {
  await loginAs(page, 'accountant');
  await page.locator('.nav-item[data-tab="staff"]').click();
  await page.locator('#staffMonthInput').fill(previousMonth());
  await expect(page.locator('#staffRulesSummary')).toContainText('ish kuni');

  // Nobody was marked last month, yet nobody loses money for it.
  const rows = page.locator('#staffPayrollTableBody tr');
  await expect(rows.first()).toBeVisible();
  await expect(page.locator('#staffPayrollTableBody td .text-rose')).toHaveCount(0);
  await expect(page.locator('#staffPayrollTableBody')).not.toContainText('kun kelmagan');
});

test('accountant types a deduction and the amount to pay follows it', async ({ page }) => {
  await loginAs(page, 'accountant');
  await page.locator('.nav-item[data-tab="staff"]').click();

  const row = page.locator('#staffPayrollTableBody tr').filter({ has: page.locator('.deduction-edit') }).first();
  const name = (await row.locator('td').first().locator('b').innerText()).trim();
  const named = page.locator('#staffPayrollTableBody tr').filter({ hasText: name });

  await named.locator('.deduction-edit').click();
  await expect(page.locator('#deductionModal')).toHaveClass(/open/);
  await page.locator('#deductionAmount').fill('150000');
  await expect(page.locator('#deductionResult')).toContainText("To'lanadigan summa");
  await page.locator('#deductionNote').fill('2 kun sababsiz kelmadi');
  await page.locator('#deductionSubmit').click();

  await expect(page.locator('#deductionModal')).not.toHaveClass(/open/);
  await expect(deductionCell(named)).toContainText('150,000');
  await expect(deductionCell(named)).toContainText('2 kun sababsiz kelmadi');
  await expect(deductionCell(named).locator('.text-rose')).toHaveCount(1);
});

test('a deduction larger than the salary is refused', async ({ page }) => {
  await loginAs(page, 'accountant');
  await page.locator('.nav-item[data-tab="staff"]').click();
  const row = page.locator('#staffPayrollTableBody tr').filter({ has: page.locator('.deduction-edit') }).first();
  await row.locator('.deduction-edit').click();
  // Bypass the input's own max to make sure the server refuses it as well.
  await page.locator('#deductionAmount').evaluate(el => { el.removeAttribute('max'); el.value = '999999999'; });
  await page.locator('#deductionSubmit').click();
  await expect(page.locator('.toast-warning')).toContainText('maoshdan katta');
});

test('past staff attendance can still be corrected from the monthly sheet', async ({ page }) => {
  await loginAs(page, 'accountant');
  await page.locator('.nav-item[data-tab="staff"]').click();
  const firstSheetRow = page.locator('#staffSheetBody tr:not(.staff-section-row)').first();
  await firstSheetRow.locator('.staff-sheet-day').first().click();
  await expect(page.locator('#staffAttList .staff-att-row').first()).toBeVisible();
  await page.locator('#staffAttList .staff-att-row').first().locator('.att-btn[data-status="EXCUSED"]').click();
  await expect(firstSheetRow.locator('.e-cell').first()).toBeVisible();
});

test('future days cannot be picked for staff attendance', async ({ page }) => {
  await loginAs(page, 'accountant');
  await page.locator('.nav-item[data-tab="staff"]').click();
  const max = await page.locator('#staffAttDate').getAttribute('max');
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  expect(max).toBe(iso);
});
