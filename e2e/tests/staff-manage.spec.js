const { test, expect } = require('@playwright/test');
const { loginAs, API_BASE } = require('../helpers');

for (const role of ['accountant', 'super_admin']) {
  test(`${role} can add and then remove a staff member from the Staff tab`, async ({ page }) => {
    await loginAs(page, role);
    await page.locator('.nav-item[data-tab="staff"]').click();

    const name = `Sinov Xodim ${Date.now()}`;
    await page.locator('[data-perm-action="staff.manage"]').click();
    await expect(page.locator('#addStaffModal')).toBeVisible();
    await page.locator('#newStaffName').fill(name);
    await page.locator('#newStaffRole').fill('Тарбиячи');
    await page.locator('#newStaffPhone').fill('+998901234599');
    await page.locator('#newStaffSalary').fill('3500000');
    await page.locator('#addStaffSubmitBtn').click();

    const row = page.locator('#staffPayrollTableBody tr', { hasText: name });
    await expect(row).toBeVisible();

    await row.locator('.staff-delete-btn').click();
    await expect(page.locator('#deleteStaffModal')).toHaveClass(/open/);
    await page.locator('#deleteStaffSubmit').click();
    await expect(row).toHaveCount(0);
    await expect(page.locator('#staffSheetBody')).not.toContainText(name);
  });
}

for (const role of ['director']) {
  test(`${role} sees the Staff tab but no add or delete buttons`, async ({ page }) => {
    await loginAs(page, role);
    await page.locator('.nav-item[data-tab="staff"]').click();
    await expect(page.locator('#staffPayrollTableBody tr').first()).toBeVisible();
    await expect(page.locator('[data-perm-action="staff.manage"]')).toBeHidden();
    await expect(page.locator('.staff-delete-btn')).toHaveCount(0);
  });
}

test('accountant changes an employee salary with the edit button', async ({ page }) => {
  await loginAs(page, 'accountant');
  await page.locator('.nav-item[data-tab="staff"]').click();
  const row = page.locator('#staffPayrollTableBody tr').filter({ has: page.locator('.salary-edit') }).first();
  const name = (await row.locator('td').first().locator('b').innerText()).trim();
  const named = page.locator('#staffPayrollTableBody tr').filter({ hasText: name });

  await named.locator('.salary-edit').click();
  await expect(page.locator('#salaryModal')).toHaveClass(/open/);
  await page.locator('#salaryAmount').fill('4321000');
  await page.locator('#salarySubmit').click();
  await expect(page.locator('#salaryModal')).not.toHaveClass(/open/);
  await expect(named.locator('td').nth(2)).toContainText('4,321,000');
});

test('director does not see the salary edit button', async ({ page }) => {
  await loginAs(page, 'director');
  await page.locator('.nav-item[data-tab="staff"]').click();
  await expect(page.locator('#staffPayrollTableBody tr').first()).toBeVisible();
  await expect(page.locator('.salary-edit')).toHaveCount(0);
});

test('staff list is split into Rahbariyat and Asosiy bo\'lim, and names can be edited', async ({ page }) => {
  await loginAs(page, 'accountant');
  // The demo data has no leadership staff, so add one to see both sections.
  const token = await page.evaluate(() => localStorage.getItem('bogcha_token'));
  const created = await page.request.post(`${API_BASE}/staff`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: 'BEGLOVA SINOV', role: 'Бухгалтер', base_salary: 1000000, department: 'RAHBARIYAT' },
  });
  expect(created.ok()).toBeTruthy();
  await page.reload();
  await page.locator('.nav-item[data-tab="staff"]').click();
  const sections = page.locator('#staffPayrollTableBody .staff-section-row');
  await expect(sections.first()).toBeVisible();
  const titles = await sections.allInnerTexts();
  expect(titles.map(s => s.trim().toLowerCase())).toEqual(["rahbariyat", "asosiy bo'lim"]);

  const row = page.locator('#staffPayrollTableBody tr').filter({ has: page.locator('.staff-edit') }).last();
  await row.locator('.staff-edit').click();
  await expect(page.locator('#editStaffModal')).toHaveClass(/open/);
  const newName = `TAHRIR SINOV ${Date.now()}`;
  await page.locator('#editStaffName').fill(newName);
  await page.locator('#editStaffSubmit').click();
  await expect(page.locator('#editStaffModal')).not.toHaveClass(/open/);
  await expect(page.locator('#staffPayrollTableBody')).toContainText(newName);
});

test('director cannot edit staff details', async ({ page }) => {
  await loginAs(page, 'director');
  await page.locator('.nav-item[data-tab="staff"]').click();
  await expect(page.locator('#staffPayrollTableBody tr').first()).toBeVisible();
  await expect(page.locator('.staff-edit')).toHaveCount(0);
});

test('names can also be edited from the staff attendance list', async ({ page }) => {
  await loginAs(page, 'super_admin');
  await page.locator('.nav-item[data-tab="staff"]').click();
  const row = page.locator('#staffAttList .staff-att-row').first();
  await row.locator('.staff-edit').click();
  await expect(page.locator('#editStaffModal')).toHaveClass(/open/);
  const newName = `DAVOMATDAN TAHRIR ${Date.now()}`;
  await page.locator('#editStaffName').fill(newName);
  await page.locator('#editStaffSubmit').click();
  await expect(page.locator('#staffAttList')).toContainText(newName);
});
