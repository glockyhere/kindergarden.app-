"""
Bog'chaOS Backend Database Engine — Enterprise Pro
Barcha 7 ta modul: Rollar, Tabel, Omborxona, To'garaklar, Xodimlar/Maosh, Shartnomalar va Galereya.
"""
import sqlite3
import os
import json
import secrets
import string
from datetime import datetime, date

# Override for tests/deployment, e.g. BOGCHA_DB_PATH=/tmp/test.db; never touches
# the real database unless this is unset.
DB_PATH = os.getenv("BOGCHA_DB_PATH") or os.path.join(os.path.dirname(__file__), "..", "bogcha_data.db")

def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_connection()
    cursor = conn.cursor()

    cursor.executescript("""
    -- 1. Tashkilotlar
    CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        phone TEXT NOT NULL,
        address TEXT,
        plan_tier TEXT DEFAULT 'PRO',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- 1.1. Foydalanuvchilar (Users & Auth)
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        role TEXT NOT NULL, -- 'DIRECTOR', 'TEACHER', 'ACCOUNTANT'
        full_name TEXT NOT NULL,
        phone TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        avatar TEXT,
        is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- 2. Guruhlar
    CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        name TEXT NOT NULL,
        age_category TEXT NOT NULL,
        capacity INTEGER DEFAULT 25,
        teacher_name TEXT NOT NULL,
        monthly_fee REAL NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- 3. Bolalar
    CREATE TABLE IF NOT EXISTS children (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        name TEXT NOT NULL,
        birth_date TEXT NOT NULL,
        gender TEXT,
        parent_name TEXT NOT NULL,
        parent_phone TEXT NOT NULL,
        parent_chat_id INTEGER,
        allergies TEXT DEFAULT 'Yo''q',
        contract_number TEXT,
        contract_date TEXT,
        status TEXT DEFAULT 'ACTIVE',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (group_id) REFERENCES groups(id)
    );

    -- 4. Kunlik Davomat
    CREATE TABLE IF NOT EXISTS attendance (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        child_id TEXT NOT NULL,
        group_name TEXT NOT NULL,
        date TEXT NOT NULL,
        status TEXT NOT NULL, -- 'PRESENT', 'ABSENT', 'EXCUSED'
        check_in_time TEXT,
        notes TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(child_id, date)
    );

    -- 5. Oylik Tabel (31 kunlik matritsa va kompensatsiya)
    CREATE TABLE IF NOT EXISTS monthly_tabel (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        child_id TEXT NOT NULL,
        month TEXT NOT NULL, -- '2026-10'
        days_json TEXT NOT NULL, -- {"1": "P", "2": "P", "3": "E", ...}
        days_present INTEGER DEFAULT 0,
        days_absent INTEGER DEFAULT 0,
        days_excused INTEGER DEFAULT 0,
        food_daily_norm REAL DEFAULT 25000, -- Kunlik ovqatlanish normasi
        compensation_amount REAL DEFAULT 0, -- Kelmagan kunlar uchun qaytariladigan summa
        UNIQUE(child_id, month)
    );

    -- 6. Invoyslar va To'lovlar
    CREATE TABLE IF NOT EXISTS invoices (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        child_id TEXT NOT NULL,
        invoice_number TEXT NOT NULL,
        billing_period TEXT NOT NULL,
        amount_due REAL NOT NULL,
        amount_paid REAL DEFAULT 0,
        compensation_discount REAL DEFAULT 0,
        status TEXT DEFAULT 'UNPAID', -- 'PAID', 'DEBT'
        due_date TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- 7. Omborxona Mahsulotlari (Warehouse Items)
    CREATE TABLE IF NOT EXISTS warehouse_items (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL, -- 'GO''SHT', 'SUT', 'SABZAVOT', 'QURUQ', 'NON'
        unit TEXT NOT NULL, -- 'kg', 'litr', 'dona'
        quantity REAL NOT NULL DEFAULT 0,
        min_quantity REAL NOT NULL DEFAULT 5, -- Kritik chegara
        price_per_unit REAL NOT NULL DEFAULT 0,
        last_updated TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- 8. Omborxona Kirim/Chiqim Tarixi
    CREATE TABLE IF NOT EXISTS warehouse_transactions (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        type TEXT NOT NULL, -- 'KIRIM', 'CHIQIM'
        quantity REAL NOT NULL,
        unit_price REAL DEFAULT 0,
        source_or_chef TEXT, -- Ta'minotchi yoki Oshpaz ismi
        date TEXT NOT NULL,
        notes TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (item_id) REFERENCES warehouse_items(id)
    );

    -- 9. To'garaklar (Clubs & Extracurriculars)
    CREATE TABLE IF NOT EXISTS clubs (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        name TEXT NOT NULL,
        teacher_name TEXT NOT NULL,
        schedule TEXT NOT NULL,
        monthly_fee REAL NOT NULL,
        icon TEXT DEFAULT '🎨',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS child_clubs (
        child_id TEXT NOT NULL,
        club_id TEXT NOT NULL,
        enrolled_date TEXT DEFAULT CURRENT_DATE,
        PRIMARY KEY (child_id, club_id),
        FOREIGN KEY (child_id) REFERENCES children(id),
        FOREIGN KEY (club_id) REFERENCES clubs(id)
    );

    -- 10. Xodimlar va Ish Haqi (Staff & Payroll)
    CREATE TABLE IF NOT EXISTS staff (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL, -- 'TARBIYACHI', 'ENAGA', 'OSHPAZ', 'HAMSHIRA', 'QOROVUL'
        phone TEXT NOT NULL,
        base_salary REAL NOT NULL,
        hire_date TEXT NOT NULL,
        status TEXT DEFAULT 'ACTIVE',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS staff_payroll (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        staff_id TEXT NOT NULL,
        month TEXT NOT NULL,
        base_salary REAL NOT NULL,
        bonus REAL DEFAULT 0,
        advance_paid REAL DEFAULT 0,
        final_paid REAL DEFAULT 0,
        status TEXT DEFAULT 'PENDING', -- 'PAID', 'PENDING'
        paid_date TEXT,
        FOREIGN KEY (staff_id) REFERENCES staff(id)
    );

    -- 10.1 To'lovlar Tarixi (actual payment events, for income statistics)
    CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        child_id TEXT NOT NULL,
        invoice_id TEXT NOT NULL,
        amount REAL NOT NULL,
        method TEXT DEFAULT 'CLICK',
        paid_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- 10.2 Xodimlar davomati
    CREATE TABLE IF NOT EXISTS staff_attendance (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        staff_id TEXT NOT NULL,
        date TEXT NOT NULL,
        status TEXT NOT NULL, -- 'PRESENT', 'ABSENT', 'EXCUSED', 'LATE'
        check_in_time TEXT,
        UNIQUE(staff_id, date)
    );

    -- 10.3 Qarz eslatmalari sozlamalari va jurnali
    CREATE TABLE IF NOT EXISTS reminder_settings (
        org_id TEXT PRIMARY KEY,
        enabled INTEGER DEFAULT 0,
        days_before INTEGER DEFAULT 5,
        days_after INTEGER DEFAULT 5,
        times TEXT DEFAULT '["09:00"]',
        template TEXT
    );

    CREATE TABLE IF NOT EXISTS reminder_log (
        org_id TEXT NOT NULL,
        invoice_id TEXT NOT NULL,
        sent_date TEXT NOT NULL,
        slot TEXT NOT NULL,
        PRIMARY KEY (invoice_id, sent_date, slot)
    );

    -- 12. Ошхона харажатлари (Haftalik oziq-ovqat xarajatlari)
    CREATE TABLE IF NOT EXISTS food_expense_reports (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        week_start TEXT NOT NULL,
        week_end TEXT NOT NULL,
        child_count INTEGER NOT NULL,
        total_amount REAL NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(org_id, week_start)
    );

    CREATE TABLE IF NOT EXISTS food_expense_items (
        id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        name TEXT NOT NULL,
        quantity REAL NOT NULL,
        unit_price REAL NOT NULL,
        line_total REAL NOT NULL,
        FOREIGN KEY (report_id) REFERENCES food_expense_reports(id)
    );

    -- 11. Faoliyat Jurnali
    CREATE TABLE IF NOT EXISTS activity_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id TEXT NOT NULL,
        icon TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- 13. Audit Trail — who changed a sensitive field (price, discount, a
    -- deletion, ...) and when. Separate from activity_logs above, which is
    -- a general feed shown to all staff; this is management-only (see
    -- PERMISSIONS["audit.view"]) and keeps the before/after values.
    CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        actor_role TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        target_label TEXT,
        changes TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # Seed Default Data if empty or missing new tables
    cursor.execute("SELECT COUNT(*) FROM warehouse_items")
    if cursor.fetchone()[0] == 0:
        seed_all_data(cursor)

    migrate(cursor)

    conn.commit()
    conn.close()

def migrate(cursor):
    from app.security import hash_password, is_hashed

    existing = {r[1] for r in cursor.execute("PRAGMA table_info(children)")}
    for column, ddl in (("monthly_fee", "REAL"), ("discount", "TEXT"), ("note", "TEXT")):
        if column not in existing:
            cursor.execute(f"ALTER TABLE children ADD COLUMN {column} {ddl}")

    payment_columns = {r[1] for r in cursor.execute("PRAGMA table_info(payments)")}
    for column in ("period", "note", "recorded_by"):
        if column not in payment_columns:
            cursor.execute(f"ALTER TABLE payments ADD COLUMN {column} TEXT")

    group_columns = {r[1] for r in cursor.execute("PRAGMA table_info(groups)")}
    if "teacher2_name" not in group_columns:
        cursor.execute("ALTER TABLE groups ADD COLUMN teacher2_name TEXT")

    org_columns = {r[1] for r in cursor.execute("PRAGMA table_info(organizations)")}
    for column in ("telegram_group_id", "telegram_group_title", "telegram_group_username"):
        if column not in org_columns:
            cursor.execute(f"ALTER TABLE organizations ADD COLUMN {column} TEXT")

    for column, ddl in (("staff_late_penalty_pct", "REAL"), ("staff_deduction_start", "TEXT")):
        if column not in org_columns:
            cursor.execute(f"ALTER TABLE organizations ADD COLUMN {column} {ddl}")
    # Deductions treat unmarked working days as absences, so they must not reach back
    # into months that were never tracked: start from the next full month by default.
    today = date.today()
    next_month = date(today.year + (today.month == 12), today.month % 12 + 1, 1).isoformat()
    cursor.execute("UPDATE organizations SET staff_late_penalty_pct = 25 WHERE staff_late_penalty_pct IS NULL")
    cursor.execute("UPDATE organizations SET staff_deduction_start = ? WHERE staff_deduction_start IS NULL", (next_month,))

    payroll_columns = {r[1] for r in cursor.execute("PRAGMA table_info(staff_payroll)")}
    for column, ddl in (("absent_days", "INTEGER"), ("late_days", "INTEGER"),
                        ("absence_deduction", "REAL"), ("late_deduction", "REAL")):
        if column not in payroll_columns:
            cursor.execute(f"ALTER TABLE staff_payroll ADD COLUMN {column} {ddl}")

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS org_holidays (
        org_id TEXT NOT NULL,
        date TEXT NOT NULL,
        name TEXT,
        PRIMARY KEY (org_id, date)
    )""")
    # Fixed-date public holidays of Uzbekistan; movable ones (Ramazon/Qurbon hayit) are added in Settings.
    for (org_id,) in cursor.execute("SELECT id FROM organizations").fetchall():
        if cursor.execute("SELECT 1 FROM org_holidays WHERE org_id = ? LIMIT 1", (org_id,)).fetchone():
            continue
        for year in (today.year, today.year + 1):
            for md, name in (("01-01", "Yangi yil"), ("03-08", "Xotin-qizlar kuni"), ("03-21", "Navro'z"),
                             ("05-09", "Xotira va qadrlash kuni"), ("09-01", "Mustaqillik kuni"),
                             ("10-01", "O'qituvchi va murabbiylar kuni"), ("12-08", "Konstitutsiya kuni")):
                cursor.execute("INSERT OR IGNORE INTO org_holidays (org_id, date, name) VALUES (?, ?, ?)",
                               (org_id, f"{year}-{md}", name))

    # Older databases stored passwords as plain text; hash them in place (the password itself is unchanged).
    for user_id, stored in cursor.execute("SELECT id, password_hash FROM users").fetchall():
        if not is_hashed(stored):
            cursor.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(stored), user_id))

def seed_all_data(cursor):
    org_id = "org_smart_kids"

    # 1. Organization
    cursor.execute("""
    INSERT OR REPLACE INTO organizations (id, name, slug, phone, address, plan_tier)
    VALUES (?, ?, ?, ?, ?, ?)
    """, (org_id, "Smart Kids Academy", "smart-kids", "+998712001122", "Toshkent sh., Chilonzor 5-mavze", "PRO"))

    # 1.1 Users (Direktor, Tarbiyachi, Buxgalter, Super Admin, Hamshira)
    # Passwords are generated fresh on first run — never hardcode real credentials here.
    alphabet = string.ascii_letters + string.digits + "!@#$%^&*-_="
    # BOGCHA_SEED_PASSWORD gives every seeded account one known password, for
    # demo deployments whose database is rebuilt on each fresh start.
    seed_password = os.getenv("BOGCHA_SEED_PASSWORD")
    def gen_password(length=16):
        return seed_password or "".join(secrets.choice(alphabet) for _ in range(length))

    users = [
        ("u_dir", org_id, "DIRECTOR", "Nodira Azimova", "+998901112233", gen_password(), "NA"),
        ("u_teacher", org_id, "TEACHER", "Gulbahor Karimova", "+998934445566", gen_password(), "GK"),
        ("u_acc", org_id, "ACCOUNTANT", "Alisher Zokirov", "+998941112233", gen_password(), "AZ"),
        ("u_superadmin", org_id, "SUPER_ADMIN", "Nigora", "+998900000001", gen_password(), "N"),
        ("u_nurse2", org_id, "NURSE", "Turdiqulova Nozliyaoy", "+998900000002", gen_password(), "TN"),
    ]
    # Extra super admin from the deployment's environment, so its password never
    # lives in the repository.
    admin_phone, admin_password = os.getenv("BOGCHA_ADMIN_PHONE"), os.getenv("BOGCHA_ADMIN_PASSWORD")
    if admin_phone and admin_password:
        users.append(("u_admin_env", org_id, "SUPER_ADMIN", "Super Admin", admin_phone, admin_password, "SA"))
    from app.security import hash_password
    cursor.executemany(
        "INSERT OR REPLACE INTO users (id, org_id, role, full_name, phone, password_hash, avatar) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [(uid, org, role, name, phone, hash_password(pw), av) for uid, org, role, name, phone, pw, av in users],
    )

    # Shown once on first run only; the database keeps just the hashes.
    print("[Bog'chaOS] Birinchi marta ishga tushirildi — yangi parollar yaratildi:")
    for uid, _, role, name, phone, pw, _ in users:
        print(f"  {role:12s} | {name:25s} | {phone:16s} | {'(env)' if uid == 'u_admin_env' else pw}")

    # 2. Groups
    groups = [
        ("g1", org_id, "Yulduzcha", "3-4 yosh", 25, "Gulbahor Karimova", 1800000),
        ("g2", org_id, "Qaldirg'och", "5-6 yosh", 25, "Nargiza Olimova", 2000000),
        ("g3", org_id, "Kichkintoy", "2-3 yosh", 20, "Dilfuza Ahmedova", 1600000),
        ("g4", org_id, "Zukko", "4-5 yosh", 25, "Malika Rasulova", 1900000),
        ("g5", org_id, "Kamalak", "4-5 yosh", 25, "Feruza Usmonova", 1800000),
    ]
    cursor.executemany("INSERT OR REPLACE INTO groups VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)", groups)

    # 3. Children
    children = [
        ("c1", org_id, "g1", "Imron Rahimov", "15.04.2022 (4 yosh)", "MALE", "Xurshid Rahimov (Dada)", "+998 90 123 45 67", None, "Tuxum oqiga allergiya", "SH-2025-042", "01.09.2025", "ACTIVE"),
        ("c2", org_id, "g1", "Madina Saidova", "20.06.2022 (4 yosh)", "FEMALE", "Nodira Saidova (Ona)", "+998 93 456 78 90", None, "Yo'q", "SH-2025-043", "01.09.2025", "ACTIVE"),
        ("c3", org_id, "g1", "Jasur Aliyev", "10.01.2022 (4 yosh)", "MALE", "Alisher Aliyev (Dada)", "+998 97 777 88 99", None, "Laktaza yetishmovchiligi (sutsiz)", "SH-2025-044", "01.09.2025", "ACTIVE"),
        ("c4", org_id, "g1", "Fotima Zokirova", "05.08.2022 (4 yosh)", "FEMALE", "Dilnoza Zokirova (Ona)", "+998 99 333 44 55", None, "Yo'q", "SH-2025-045", "01.09.2025", "ACTIVE"),
        ("c5", org_id, "g1", "Zuhra Zokirova", "05.08.2022 (4 yosh)", "FEMALE", "Dilnoza Zokirova (Ona)", "+998 99 333 44 55", None, "Yo'q", "SH-2025-046", "01.09.2025", "ACTIVE"),
        ("c6", org_id, "g2", "Temur Mirzayev", "12.02.2020 (6 yosh)", "MALE", "Rustam Mirzayev (Dada)", "+998 90 900 12 34", None, "Yong'oqqa allergiya", "SH-2025-047", "01.09.2025", "ACTIVE"),
        ("c7", org_id, "g2", "Sarvar Qodirov", "19.09.2020 (6 yosh)", "MALE", "Gulchehra Qodirova (Ona)", "+998 91 111 22 44", None, "Yo'q", "SH-2025-048", "01.09.2025", "ACTIVE"),
        ("c8", org_id, "g3", "Muslima Ergasheva", "02.11.2023 (3 yosh)", "FEMALE", "Bekzod Ergashev (Dada)", "+998 94 666 77 88", None, "Sitrus mevalar", "SH-2025-049", "01.09.2025", "ACTIVE"),
        ("c9", org_id, "g1", "Otabek Shokirov", "12.03.2022 (4 yosh)", "MALE", "Rustam Shokirov (Dada)", "+998 90 999 88 77", None, "Yo'q", "SH-2025-050", "02.10.2026", "ACTIVE"),
    ]
    cursor.executemany("INSERT OR REPLACE INTO children VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)", children)

    # 4. Omborxona Mahsulotlari (Warehouse Stock)
    stock = [
        ("wh_1", org_id, "Mol Go'shti (Lohash)", "GO'SHT", "kg", 45.5, 10.0, 95000),
        ("wh_2", org_id, "Tovuq Filisi", "GO'SHT", "kg", 28.0, 8.0, 48000),
        ("wh_3", org_id, "Pasterizatsiyalangan Sut 3.2%", "SUT", "litr", 6.5, 15.0, 11000), # Kritik!
        ("wh_4", org_id, "Sariyog' 82.5%", "SUT", "kg", 14.2, 5.0, 85000),
        ("wh_5", org_id, "Kartoshka (Sariq)", "SABZAVOT", "kg", 85.0, 20.0, 6000),
        ("wh_6", org_id, "Piyoz va Sabzi", "SABZAVOT", "kg", 42.0, 15.0, 4500),
        ("wh_7", org_id, "Guruch (Alanga)", "QURUQ", "kg", 50.0, 10.0, 18000),
        ("wh_8", org_id, "O'simlik yog'i (Pista)", "QURUQ", "litr", 32.0, 10.0, 19000),
        ("wh_9", org_id, "Buxanka Non (Oliy nav)", "NON", "dona", 30.0, 10.0, 3500),
        ("wh_10", org_id, "Mavsumiy Olma", "SABZAVOT", "kg", 4.0, 10.0, 12000), # Kritik!
    ]
    cursor.executemany("INSERT OR REPLACE INTO warehouse_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)", stock)

    # 5. Omborxona Kirim/Chiqim Tarixi
    txs = [
        ("tx_1", org_id, "wh_1", "KIRIM", 50.0, 95000, "Go'sht Savdo MCHJ", "2026-10-01", "Haftalik yangi partiya"),
        ("tx_2", org_id, "wh_1", "CHIQIM", 4.5, 0, "Oshpaz: Salim aka", "2026-10-02", "Bugungi tushlik sho'rva va teftel uchun"),
        ("tx_3", org_id, "wh_3", "CHIQIM", 18.0, 0, "Oshpaz: Salim aka", "2026-10-02", "Nonushta kashasi uchun"),
        ("tx_4", org_id, "wh_5", "KIRIM", 100.0, 6000, "Qo'yliq Dehqon Bozori", "2026-10-01", "Oylik zaxira"),
    ]
    cursor.executemany("INSERT OR REPLACE INTO warehouse_transactions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)", txs)

    # 6. To'garaklar (Clubs)
    clubs = [
        ("club_1", org_id, "Mental Arifmetika & Mantiq", "Shoxrux Boboyev", "Dush / Chor / Juma (15:00)", 250000, "🧮"),
        ("club_2", org_id, "English for Kids (Interaktiv)", "Diana Kim", "Sesh / Pay / Shanba (15:30)", 300000, "🇬🇧"),
        ("club_3", org_id, "Gimnastika & Xoreografiya", "Kamila Rahimova", "Sesh / Payba (16:30)", 200000, "🤸"),
        ("club_4", org_id, "Shaxmat Maktabi", "Olimjon Rustamov", "Chor / Juma (16:00)", 200000, "♟️"),
        ("club_5", org_id, "Logopedik Yakkama-yakka Mashg'ulot", "Nodira Karimova", "Kelishuv asosida", 400000, "🗣️"),
    ]
    cursor.executemany("INSERT OR REPLACE INTO clubs VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)", clubs)

    # Child-Clubs enrollments
    child_clubs = [
        ("c1", "club_2", "2026-09-10"),
        ("c1", "club_4", "2026-09-15"),
        ("c2", "club_1", "2026-09-10"),
        ("c2", "club_3", "2026-09-10"),
        ("c3", "club_5", "2026-09-20"),
        ("c6", "club_4", "2026-09-12"),
        ("c7", "club_2", "2026-09-10"),
    ]
    cursor.executemany("INSERT OR REPLACE INTO child_clubs VALUES (?, ?, ?)", child_clubs)

    # 7. Xodimlar va Oylik Maosh (Staff & Payroll)
    staff_members = [
        ("st_1", org_id, "Gulbahor Karimova", "TARBIYACHI", "+998 93 444 55 66", 4500000, "2023-09-01", "ACTIVE"),
        ("st_2", org_id, "Nargiza Olimova", "TARBIYACHI", "+998 90 222 33 44", 4500000, "2023-11-15", "ACTIVE"),
        ("st_3", org_id, "Dilnoza Ahmedova", "ENAGA", "+998 94 111 55 77", 2800000, "2024-01-10", "ACTIVE"),
        ("st_4", org_id, "Salim Rahmonov", "OSHPAZ", "+998 97 888 99 00", 5000000, "2023-08-20", "ACTIVE"),
        ("st_5", org_id, "Umida Qosimova", "HAMSHIRA", "+998 91 333 77 11", 3500000, "2024-03-01", "ACTIVE"),
        ("st_6", org_id, "Botir To'rayev", "QOROVUL / XO'JALIK", "+998 90 777 22 11", 2500000, "2023-09-01", "ACTIVE"),
    ]
    cursor.executemany("INSERT OR REPLACE INTO staff VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)", staff_members)

    payrolls = [
        ("pr_1", org_id, "st_1", "2026-10", 4500000, 500000, 2000000, 3000000, "PAID", "2026-10-01"),
        ("pr_2", org_id, "st_2", "2026-10", 4500000, 300000, 1500000, 3300000, "PENDING", None),
        ("pr_3", org_id, "st_3", "2026-10", 2800000, 0, 1000000, 1800000, "PENDING", None),
        ("pr_4", org_id, "st_4", "2026-10", 5000000, 600000, 2500000, 3100000, "PAID", "2026-10-01"),
        ("pr_5", org_id, "st_5", "2026-10", 3500000, 200000, 1000000, 2700000, "PENDING", None),
    ]
    cursor.executemany("INSERT OR REPLACE INTO staff_payroll VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", payrolls)

    # 8. Oylik Tabel (31 kunlik simulyatsiya va kompensatsiya)
    # P = Keldi, E = Sababli, A = Kelmadi
    month_days_c1 = {str(i): ("E" if i in [5, 6] else "P") for i in range(1, 23)}
    month_days_c3 = {str(i): ("E" if i in [3, 4, 5, 6, 7] else "P") for i in range(1, 23)} # 5 kun sababli!
    month_days_c4 = {str(i): ("A" if i in [1, 2] else "P") for i in range(1, 23)}

    tabels = [
        ("tb_c1", org_id, "c1", "2026-10", json.dumps(month_days_c1), 20, 0, 2, 25000, 50000), # 2 kun * 25k = 50,000 UZS kompensatsiya
        ("tb_c2", org_id, "c2", "2026-10", json.dumps({str(i): "P" for i in range(1, 23)}), 22, 0, 0, 25000, 0),
        ("tb_c3", org_id, "c3", "2026-10", json.dumps(month_days_c3), 17, 0, 5, 25000, 125000), # 5 kun * 25k = 125,000 UZS kompensatsiya
        ("tb_c4", org_id, "c4", "2026-10", json.dumps(month_days_c4), 20, 2, 0, 25000, 0),
    ]
    cursor.executemany("INSERT OR REPLACE INTO monthly_tabel VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", tabels)
