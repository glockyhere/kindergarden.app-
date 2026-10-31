"""
Bog'chaOS REST API Server (FastAPI)
"""
import asyncio
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
from app.database import init_db
from app import finance, telegram_bot
from app.routes import dashboard, children, attendance, billing, tabel, staff, auth, telegram, kitchen, audit, settings, reports

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    print("[Bog'chaOS Backend] Malumotlar bazasi va jadvallar muvaffaqiyatli ishga tushirildi.")

    stop = asyncio.Event()
    reminders = asyncio.create_task(finance.run_reminder_scheduler(stop))
    poller = None
    if telegram_bot.bot_enabled():
        poller = asyncio.create_task(telegram_bot.run_polling(stop))
        print("[Bog'chaOS Backend] Telegram bot ulandi: ota-onalar /start orqali ro'yxatdan o'tishi mumkin.")
    else:
        print("[Bog'chaOS Backend] Telegram bot tokeni yo'q: xabarlar yuborilmaydi.")
    yield
    stop.set()
    reminders.cancel()
    if poller:
        poller.cancel()

app = FastAPI(
    title="Bog'chaOS Backend API",
    description="Xususiy bog'chalar uchun B2B SaaS platformasi REST API xizmati.",
    version="1.0.0",
    lifespan=lifespan
)

# Only the dashboard's own origins may call the API. Set BOGCHA_ALLOWED_ORIGINS
# (comma-separated) when deploying to a real domain.
ALLOWED_ORIGINS = [
    o.strip() for o in os.getenv(
        "BOGCHA_ALLOWED_ORIGINS", "http://localhost:4321,http://127.0.0.1:4321"
    ).split(",") if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)

# Routerlarni ulash
app.include_router(auth.router)
app.include_router(dashboard.router)
app.include_router(children.router)
app.include_router(attendance.router)
app.include_router(billing.router)
app.include_router(tabel.router)
app.include_router(staff.router)
app.include_router(telegram.router)
app.include_router(kitchen.router)
app.include_router(audit.router)
app.include_router(settings.router)
app.include_router(reports.router)

@app.get("/api")
def root():
    return {
        "app": "Bog'chaOS SaaS API",
        "version": "1.0.0",
        "status": "online",
        "docs_url": "/docs"
    }

# When deployed, the backend also serves the dashboard so both share one origin.
FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "frontend")
if os.path.isdir(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=True)
