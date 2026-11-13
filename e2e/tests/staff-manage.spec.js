const { test, expect } = require('@playwright/test');
const { loginAs } = require('../helpers');

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
