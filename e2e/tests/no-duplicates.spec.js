const { test, expect } = require('@playwright/test');
const { loginAs } = require('../helpers');

test('adding a staff member with an existing name is refused and says why', async ({ page }) => {
  await loginAs(page, 'accountant');
  await page.locator('.nav-item[data-tab="staff"]').click();
  const existing = (await page.locator('#staffPayrollTableBody tr:not(.staff-section-row) td:first-child b').first().innerText()).trim();

  await page.locator('[data-perm-action="staff.manage"]').click();
  await page.locator('#newStaffName').fill(existing.toLowerCase());
  await page.locator('#newStaffRole').fill('Тарбиячи');
  await page.locator('#newStaffSalary').fill('1000000');
  await page.locator('#addStaffSubmitBtn').click();

  await expect(page.locator('.toast-warning')).toContainText('allaqachon');
  await expect(page.locator('#addStaffModal')).toBeVisible();
});

test('adding the same child twice is refused instead of showing a fake success', async ({ page }) => {
  await loginAs(page, 'accountant');
  await page.locator('.nav-item[data-tab="children"]').click();
  const fill = async () => {
    await page.locator('#addChildForm, #addChildModal form').first().waitFor();
  };
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: /Yangi bola qo'shish/ }).first().click();
    await fill();
    const modal = page.locator('#addChildModal');
    await modal.locator('input[type="text"]').nth(0).fill('Takror');
    await modal.locator('input[type="text"]').nth(1).fill('Sinov');
    await modal.locator('input[type="date"]').first().fill('2022-03-03');
    const tel = modal.locator('input[type="tel"]');
    if (await tel.count()) await tel.first().fill('+998901112299');
    const textInputs = modal.locator('input[type="text"]');
    const n = await textInputs.count();
    for (let k = 2; k < n; k++) if (!(await textInputs.nth(k).inputValue())) await textInputs.nth(k).fill('Ota');
    await modal.locator('button[type="submit"]').click();
    if (i === 0) await expect(page.locator('.toast-success').last()).toBeVisible();
  }
  await expect(page.locator('.toast-warning').last()).toContainText('allaqachon');
});
