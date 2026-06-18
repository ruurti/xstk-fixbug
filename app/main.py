from fastapi import FastAPI, Depends, HTTPException, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from fastapi.requests import Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import func, case, desc, update
from sqlalchemy.exc import IntegrityError
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from pydantic import BaseModel, Field
from typing import Literal, Optional
import logging
import hashlib
import random
import uuid as uuid_lib
import asyncio
import os
import urllib.parse
import urllib.request
from uuid import UUID
from pathlib import Path
import csv
import io
from decimal import Decimal, ROUND_DOWN
import html
import re

from app.database import engine, Base, get_db
from app.models import Match, MatchStatus, Bet, User, PointRechargeRequest, PointRechargeStatus, AppSetting
from app.dependencies import get_current_user, get_admin_user, ADMIN_EMAILS

logger = logging.getLogger(__name__)

app = FastAPI(title="Xác Suất & Thống Kê - Betting Engine")

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")
ASSET_VERSION = str(
    max(
        int(Path("static/css/style.css").stat().st_mtime),
        int(Path("static/css/betting-taunt.css").stat().st_mtime),
        int(Path("static/js/app.js").stat().st_mtime),
        int(Path("static/js/app-taunt.js").stat().st_mtime),
        int(Path("static/js/admin.js").stat().st_mtime),
        int(Path("static/js/profile.js").stat().st_mtime),
    )
)


NO_CACHE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
    "Surrogate-Control": "no-store",
}

CHOICE_LABELS = {"HOME": "Chủ nhà", "DRAW": "Hòa", "AWAY": "Khách"}
OUTCOME_LABELS = {
    "WIN": "Thắng",
    "LOSE": "Thua",
    "REFUND": "Hoàn điểm",
    "PENDING": "Chờ kết quả",
}

MATCH_DEFAULT_DURATION = timedelta(hours=2)
APP_TIMEZONE = ZoneInfo("Asia/Ho_Chi_Minh")
match_status_sync_task: asyncio.Task | None = None
MAX_PROFILE_NAME_LENGTH = 30
MAX_TAUNT_LENGTH = 30


def _format_coins(value: int) -> str:
    return f"{int(value):,}d"


def _provided_fields(payload: BaseModel) -> set[str]:
    fields = getattr(payload, "model_fields_set", None)
    if fields is not None:
        return set(fields)
    legacy_fields = getattr(payload, "__fields_set__", set())
    return set(legacy_fields)


def _normalize_display_name(value: Optional[str]) -> str:
    name = (value or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Ten hien thi khong duoc de trong.")
    if len(name) > MAX_PROFILE_NAME_LENGTH:
        raise HTTPException(status_code=400, detail=f"Ten hien thi toi da {MAX_PROFILE_NAME_LENGTH} ky tu.")
    return name


def _normalize_optional_taunt(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    text = value.strip()
    if not text:
        return None
    if len(text) > MAX_TAUNT_LENGTH:
        raise HTTPException(status_code=400, detail=f"Câu gáy tối đa {MAX_TAUNT_LENGTH} ký tự.")
    return text


def _local_now_naive() -> datetime:
    """Return app-local time as naive datetime for match schedule comparisons."""
    return datetime.now(APP_TIMEZONE).replace(tzinfo=None)


def _render_inline_markdown(text: str) -> str:
    escaped = html.escape(text)
    escaped = re.sub(r"`([^`]+)`", r"<code>\1</code>", escaped)
    escaped = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"\*(.+?)\*", r"<em>\1</em>", escaped)
    return escaped


def render_markdown(md_text: str) -> str:
    lines = md_text.splitlines()
    parts: list[str] = []
    list_items: list[str] = []

    def flush_list() -> None:
        nonlocal list_items
        if list_items:
            parts.append("<ul class=\"my-4 list-disc pl-6 space-y-2\">")
            parts.extend(list_items)
            parts.append("</ul>")
            list_items = []

    def flush_paragraph(paragraph_lines: list[str]) -> None:
        if not paragraph_lines:
            return
        paragraph = " ".join(s.strip() for s in paragraph_lines).strip()
        if paragraph:
            parts.append(f"<p class=\"my-4\">{_render_inline_markdown(paragraph)}</p>")

    paragraph_lines: list[str] = []

    for raw_line in lines:
        line = raw_line.rstrip()
        stripped = line.strip()

        if not stripped:
            flush_paragraph(paragraph_lines)
            paragraph_lines = []
            flush_list()
            continue

        heading_match = re.match(r"^(#{1,3})\s+(.*)$", stripped)
        if heading_match:
            flush_paragraph(paragraph_lines)
            paragraph_lines = []
            flush_list()
            level = len(heading_match.group(1))
            content = _render_inline_markdown(heading_match.group(2).strip())
            heading_classes = {
                1: "mt-0 mb-5 text-3xl md:text-4xl font-black leading-tight text-slate-950",
                2: "mt-8 mb-4 text-2xl md:text-3xl font-black leading-tight text-slate-950",
                3: "mt-6 mb-3 text-xl md:text-2xl font-extrabold leading-tight text-slate-950",
            }
            parts.append(f"<h{level} class=\"{heading_classes[level]}\">{content}</h{level}>")
            continue

        if stripped in {"---", "***", "___"}:
            flush_paragraph(paragraph_lines)
            paragraph_lines = []
            flush_list()
            parts.append("<hr class=\"my-6 border-slate-200\" />")
            continue

        list_match = re.match(r"^[*-]\s+(.*)$", stripped)
        if list_match:
            flush_paragraph(paragraph_lines)
            paragraph_lines = []
            item_html = _render_inline_markdown(list_match.group(1).strip())
            list_items.append(f"<li class=\"leading-7\">{item_html}</li>")
            continue

        if stripped.startswith("1. "):
            flush_paragraph(paragraph_lines)
            paragraph_lines = []
            flush_list()
            parts.append(
                f"<ol class=\"my-4 list-decimal pl-6 space-y-2\"><li class=\"leading-7\">{_render_inline_markdown(stripped[3:].strip())}</li></ol>"
            )
            continue

        flush_list()
        paragraph_lines.append(stripped)

    flush_paragraph(paragraph_lines)
    flush_list()
    return "\n".join(parts)

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
TELEGRAM_ADMIN_CHAT_ID = os.getenv("TELEGRAM_ADMIN_CHAT_ID", "").strip()
APP_BASE_URL = os.getenv("APP_BASE_URL", "").strip().rstrip("/")


def _send_telegram_message_sync(text: str) -> None:
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_ADMIN_CHAT_ID:
        return
    data = urllib.parse.urlencode({
        "chat_id": TELEGRAM_ADMIN_CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": "true",
    }).encode("utf-8")
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
        data=data,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=8) as response:
        response.read()


async def notify_admin_recharge_request(request_id: int, user: User, amount: int) -> None:
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_ADMIN_CHAT_ID:
        return
    admin_url = f"{APP_BASE_URL}/admin" if APP_BASE_URL else "/admin"
    text = (
        "Yêu cầu nạp điểm mới\n"
        f"Mã yêu cầu: #{request_id}\n"
        f"User: {user.email}\n"
        f"Số điểm: {amount:,}\n"
        f"Trang admin: {admin_url}"
    )
    try:
        await asyncio.to_thread(_send_telegram_message_sync, text)
    except Exception:
        logger.exception("Failed to send Telegram recharge notification.")

DEFAULT_FEATURE_SETTINGS = {
    "points_enabled": "1",
}


def _parse_bool_setting(value: Optional[str], default: bool = True) -> bool:
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


async def _ensure_default_settings(db: AsyncSession) -> None:
    existing = (await db.execute(select(AppSetting))).scalars().all()
    existing_keys = {item.key for item in existing}
    existing_values = {item.key: item.value for item in existing}
    changed = False
    for key, value in DEFAULT_FEATURE_SETTINGS.items():
        if key not in existing_keys:
            if key == "points_enabled":
                value = "1" if (
                    _parse_bool_setting(existing_values.get("topup_enabled"), True)
                    and _parse_bool_setting(existing_values.get("exchange_enabled"), True)
                ) else "0"
            db.add(AppSetting(key=key, value=value))
            changed = True
    if changed:
        await db.commit()


async def _get_feature_settings(db: AsyncSession) -> dict[str, bool]:
    await _ensure_default_settings(db)
    settings = (await db.execute(select(AppSetting))).scalars().all()
    value_map = {item.key: item.value for item in settings}
    legacy_topup = _parse_bool_setting(value_map.get("topup_enabled"), True)
    legacy_exchange = _parse_bool_setting(value_map.get("exchange_enabled"), True)
    return {
        "points_enabled": _parse_bool_setting(
            value_map.get("points_enabled"),
            legacy_topup and legacy_exchange,
        ),
    }


def _match_effective_end_time(match: Match) -> datetime:
    return match.end_time or (match.start_time + MATCH_DEFAULT_DURATION)


async def _get_match_min_stake(db: AsyncSession, match_id: int) -> Optional[int]:
    return (
        await db.execute(
            select(func.min(Bet.stake)).where(Bet.match_id == match_id)
        )
    ).scalar_one()


async def _sync_match_statuses(db: AsyncSession) -> int:
    """Promote matches based on start/end times."""
    now = _local_now_naive()
    rows = (await db.execute(
        select(Match).where(Match.status != MatchStatus.finished)
    )).scalars().all()

    changed = 0
    for match in rows:
        if match.end_time is None:
            match.end_time = match.start_time + MATCH_DEFAULT_DURATION
            changed += 1
        if match.status == MatchStatus.upcoming and now >= match.start_time:
            match.status = MatchStatus.live
            changed += 1
        if match.status == MatchStatus.live and now >= match.end_time:
            match.status = MatchStatus.finished
            changed += 1

    if changed:
        await db.commit()
    return changed


async def _match_status_sync_loop() -> None:
    while True:
        try:
            async with AsyncSession(engine) as session:
                await _sync_match_statuses(session)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Failed to sync match statuses.")
        await asyncio.sleep(30)


# ─── Startup: tạo bảng & mock data ───────────────────────────────────────────

@app.on_event("startup")
async def startup_event():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        match_columns = (
            await conn.exec_driver_sql("PRAGMA table_info(matches)")
        ).fetchall()
        match_column_names = {row[1] for row in match_columns}
        missing_match_columns = {
            "home_icon": "ALTER TABLE matches ADD COLUMN home_icon VARCHAR",
            "away_icon": "ALTER TABLE matches ADD COLUMN away_icon VARCHAR",
            "home_score": "ALTER TABLE matches ADD COLUMN home_score INTEGER DEFAULT 0",
            "away_score": "ALTER TABLE matches ADD COLUMN away_score INTEGER DEFAULT 0",
            "handicap": "ALTER TABLE matches ADD COLUMN handicap FLOAT DEFAULT 0.0",
            "status": "ALTER TABLE matches ADD COLUMN status VARCHAR DEFAULT 'upcoming'",
            "start_time": "ALTER TABLE matches ADD COLUMN start_time DATETIME",
            "end_time": "ALTER TABLE matches ADD COLUMN end_time DATETIME",
            "resolved_at": "ALTER TABLE matches ADD COLUMN resolved_at DATETIME",
        }
        for column_name, ddl in missing_match_columns.items():
            if column_name not in match_column_names:
                await conn.exec_driver_sql(ddl)

        user_columns = (
            await conn.exec_driver_sql("PRAGMA table_info(users)")
        ).fetchall()
        user_column_names = {row[1] for row in user_columns}
        if "default_taunt" not in user_column_names:
            await conn.exec_driver_sql("ALTER TABLE users ADD COLUMN default_taunt VARCHAR")

        bet_columns = (
            await conn.exec_driver_sql("PRAGMA table_info(bets)")
        ).fetchall()
        bet_column_names = {row[1] for row in bet_columns}
        if "taunt_text" not in bet_column_names:
            await conn.exec_driver_sql("ALTER TABLE bets ADD COLUMN taunt_text VARCHAR")

        await conn.exec_driver_sql(
            """
            UPDATE matches
            SET end_time = datetime(start_time, '+2 hours')
            WHERE end_time IS NULL
            """
        )

        await conn.exec_driver_sql(
            """
            UPDATE bets
            SET points_earned = NULL
            WHERE points_earned = 0
              AND match_id IN (SELECT id FROM matches WHERE status != 'finished')
            """
        )
        await conn.exec_driver_sql(
            """
            UPDATE bets
            SET points_earned = NULL
            WHERE points_earned = 0
              AND match_id IN (
                  SELECT m.id
                  FROM matches m
                  WHERE m.status = 'finished'
                    AND EXISTS (SELECT 1 FROM bets b WHERE b.match_id = m.id)
                    AND NOT EXISTS (
                        SELECT 1
                        FROM bets b2
                        WHERE b2.match_id = m.id
                          AND b2.points_earned > 0
                    )
              )
            """
        )

        duplicate_bets = (
            await conn.exec_driver_sql(
                """
                SELECT 1
                FROM bets
                GROUP BY user_id, match_id
                HAVING COUNT(*) > 1
                LIMIT 1
                """
            )
        ).first()
        if duplicate_bets:
            logger.warning("Skip unique bet index because duplicate user/match bets already exist.")
        else:
            await conn.exec_driver_sql(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_bets_user_match ON bets (user_id, match_id)"
            )

    async with AsyncSession(engine) as session:
        await _ensure_default_settings(session)
        result = await session.execute(select(Match))
        if not result.scalars().first():
            mock_matches = [
                Match(home_team="Vietnam", away_team="Thailand",
                      handicap=-0.5, status=MatchStatus.upcoming,
                      start_time=datetime(2026, 6, 20, 19, 0),
                      end_time=datetime(2026, 6, 20, 21, 0)),
                Match(home_team="Real Madrid", away_team="Barcelona",
                      handicap=-1.5, status=MatchStatus.upcoming,
                      start_time=datetime(2026, 6, 21, 2, 45),
                      end_time=datetime(2026, 6, 21, 4, 45)),
                Match(home_team="Man City", away_team="Man United",
                      handicap=0.5, status=MatchStatus.upcoming,
                      start_time=datetime(2026, 6, 22, 22, 0),
                      end_time=datetime(2026, 6, 23, 0, 0)),
            ]
            session.add_all(mock_matches)
            await session.commit()

    async with AsyncSession(engine) as session:
        await _sync_match_statuses(session)

    global match_status_sync_task
    if match_status_sync_task is None or match_status_sync_task.done():
        match_status_sync_task = asyncio.create_task(_match_status_sync_loop())


@app.on_event("shutdown")
async def shutdown_event():
    global match_status_sync_task
    if match_status_sync_task and not match_status_sync_task.done():
        match_status_sync_task.cancel()
        try:
            await match_status_sync_task
        except asyncio.CancelledError:
            pass
    match_status_sync_task = None


# ─── Pydantic Schemas ─────────────────────────────────────────────────────────

class BetPayload(BaseModel):
    match_id: int
    choice: Literal["HOME", "DRAW", "AWAY"]
    stake: int = Field(..., ge=1)
    taunt_text: Optional[str] = None

class ResolvePayload(BaseModel):
    home_score: int = Field(..., ge=0)
    away_score: int = Field(..., ge=0)

class MatchPayload(BaseModel):
    home_team: str = Field(..., min_length=1, max_length=80)
    away_team: str = Field(..., min_length=1, max_length=80)
    home_icon: Optional[str] = Field(default=None, max_length=500)
    away_icon: Optional[str] = Field(default=None, max_length=500)
    handicap: float = 0.0
    status: MatchStatus = MatchStatus.upcoming
    start_time: datetime
    end_time: datetime

class PointRechargePayload(BaseModel):
    amount: int = Field(..., ge=10, le=10000)


class AdminSettingsPayload(BaseModel):
    points_enabled: bool


class AdminUserPointsPayload(BaseModel):
    total_points: int = Field(..., ge=0, le=1_000_000_000)


# ─── Routes ──────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def read_home(request: Request):
    return templates.TemplateResponse(
        "index.html",
        {"request": request, "asset_version": ASSET_VERSION},
        headers=NO_CACHE_HEADERS,
    )

@app.get("/guide", response_class=HTMLResponse)
async def read_guide(request: Request):
    guide_path = Path(__file__).resolve().parent.parent / "guide.md"
    guide_markdown = guide_path.read_text(encoding="utf-8")
    return templates.TemplateResponse(
        "guide.html",
        {
            "request": request,
            "asset_version": ASSET_VERSION,
            "guide_html": render_markdown(guide_markdown),
        },
        headers=NO_CACHE_HEADERS,
    )

@app.get("/admin", response_class=HTMLResponse)
async def read_admin(request: Request, admin_user: User = Depends(get_admin_user)):
    return templates.TemplateResponse(
        "admin.html",
        {"request": request, "asset_version": ASSET_VERSION},
        headers=NO_CACHE_HEADERS,
    )


@app.get("/profile", response_class=HTMLResponse)
async def read_profile(request: Request, user: User = Depends(get_current_user)):
    return templates.TemplateResponse(
        "profile.html",
        {"request": request, "asset_version": ASSET_VERSION},
        headers=NO_CACHE_HEADERS,
    )


@app.get("/api/v1/me")
async def get_me(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return await _build_profile_payload(user, db=db, include_badge=True)


async def _get_user_by_id(db: AsyncSession, user_id: str) -> User:
    try:
        parsed_id = uuid_lib.UUID(user_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Người dùng không tồn tại.")

    user = (await db.execute(select(User).where(User.id == parsed_id))).scalars().first()
    if not user:
        raise HTTPException(status_code=404, detail="Người dùng không tồn tại.")
    return user


@app.get("/api/v1/users/{user_id}")
async def get_public_user_profile(
    user_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    target_user = await _get_user_by_id(db, user_id)
    payload = await _build_profile_payload(target_user, db=db, include_badge=True)
    payload["is_self"] = target_user.id == current_user.id
    payload["can_edit"] = payload["is_self"]
    if not payload["is_self"]:
        payload["email"] = None
        payload["default_taunt"] = None
    return payload


@app.get("/api/v1/users/{user_id}/bets")
async def get_public_user_bets(
    user_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    target_user = await _get_user_by_id(db, user_id)
    query = (
        select(Bet, Match)
        .join(Match, Bet.match_id == Match.id)
        .where(Bet.user_id == target_user.id)
        .order_by(Bet.created_at.desc())
    )
    rows = (await db.execute(query)).all()
    return [
        {
            "bet_id": r.Bet.id,
            "match_id": r.Match.id,
            "home_team": r.Match.home_team,
            "home_icon": r.Match.home_icon,
            "away_team": r.Match.away_team,
            "away_icon": r.Match.away_icon,
            "match_status": r.Match.status,
            "home_score": r.Match.home_score,
            "away_score": r.Match.away_score,
            "handicap": r.Match.handicap,
            "start_time": r.Match.start_time.isoformat(),
            "choice": r.Bet.choice,
            "stake": r.Bet.stake,
            "points_earned": r.Bet.points_earned,
            "created_at": r.Bet.created_at.isoformat(),
        }
        for r in rows
    ]
@app.get("/api/v1/settings")
async def get_public_settings(db: AsyncSession = Depends(get_db)):
    return await _get_feature_settings(db)


# POST /api/v1/me/update — Cập nhật thông tin cá nhân (display_name)
# Dùng POST thay vì PATCH vì Cloudflare Access Gateway chặn PATCH/PUT/DELETE
class UpdateProfilePayload(BaseModel):
    display_name: Optional[str] = None
    default_taunt: Optional[str] = None

@app.post("/api/v1/me/update-legacy")
async def update_me(
    payload: UpdateProfilePayload,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if payload.display_name is not None:
        name = payload.display_name.strip()
        if len(name) < 1:
            raise HTTPException(status_code=400, detail="Tên hiển thị không được để trống.")
        if len(name) > 30:
            raise HTTPException(status_code=400, detail="Tên hiển thị tối đa 30 ký tự.")
        user.display_name = name
    db.add(user)
    await db.commit()
    await db.refresh(user)
    base_name = user.email.split("@")[0]
    display_name = user.display_name or base_name
    return {
        "email": user.email,
        "display_name": display_name,
        "avatar_url": user.avatar_url,
        "avatar_color": user.avatar_color or "#6366f1",
        "initials": (display_name[:2]).upper(),
    }


@app.post("/api/v1/me/update")
async def update_me_v2(
    payload: UpdateProfilePayload,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    fields = _provided_fields(payload)
    if "display_name" in fields:
        user.display_name = _normalize_display_name(payload.display_name)
    if "default_taunt" in fields:
        user.default_taunt = _normalize_optional_taunt(payload.default_taunt)

    db.add(user)
    await db.commit()
    await db.refresh(user)

    display_name = _user_display_name(user)
    return {
        "email": user.email,
        "display_name": display_name,
        "avatar_url": user.avatar_url,
        "avatar_color": user.avatar_color or "#6366f1",
        "initials": _user_initials(user),
        "default_taunt": user.default_taunt,
    }


# POST /api/v1/me/avatar — Upload ảnh avatar
AVATARS_DIR = Path("static/avatars")
AVATAR_CONTENT_TYPES = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
}


def _detect_image_content_type(contents: bytes) -> Optional[str]:
    if contents.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if contents.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if contents.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(contents) >= 12 and contents[:4] == b"RIFF" and contents[8:12] == b"WEBP":
        return "image/webp"
    return None

@app.post("/api/v1/me/avatar")
async def upload_avatar(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    content_type = (file.content_type or "").split(";", 1)[0].strip().lower()
    if content_type not in AVATAR_CONTENT_TYPES:
        raise HTTPException(status_code=400, detail="Chỉ chấp nhận ảnh JPG, PNG, WebP, GIF.")

    # Đọc toàn bộ nội dung file vào bộ nhớ (async-safe)
    contents = await file.read()
    if len(contents) > 5 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Ảnh quá lớn, tối đa 5MB.")

    detected_type = _detect_image_content_type(contents)
    if detected_type != content_type:
        raise HTTPException(status_code=400, detail="Nội dung file không khớp định dạng ảnh.")

    # Tạo thư mục nếu chưa có
    AVATARS_DIR.mkdir(parents=True, exist_ok=True)
    avatars_root = AVATARS_DIR.resolve()

    # Xóa ảnh cũ nếu tồn tại
    if user.avatar_url:
        old_path = Path(user.avatar_url.lstrip("/")).resolve()
        try:
            old_path.relative_to(avatars_root)
        except ValueError:
            old_path = None
        if old_path and old_path.is_file():
            old_path.unlink(missing_ok=True)

    # Lưu ảnh mới
    ext = AVATAR_CONTENT_TYPES[content_type]
    filename = f"{uuid_lib.uuid4().hex}.{ext}"
    dest = AVATARS_DIR / filename
    dest.write_bytes(contents)

    avatar_url = f"/static/avatars/{filename}"
    user.avatar_url = avatar_url
    db.add(user)
    await db.commit()
    await db.refresh(user)

    return {"avatar_url": avatar_url}


# GET /api/v1/me/bets — Lịch sử cược của user hiện tại
@app.get("/api/v1/me/bets")
async def get_my_bets(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    query = (
        select(Bet, Match)
        .join(Match, Bet.match_id == Match.id)
        .where(Bet.user_id == user.id)
        .order_by(Bet.created_at.desc())
    )
    rows = (await db.execute(query)).all()
    return [
        {
            "bet_id": r.Bet.id,
            "match_id": r.Match.id,
            "home_team": r.Match.home_team,
            "home_icon": r.Match.home_icon,
            "away_team": r.Match.away_team,
            "away_icon": r.Match.away_icon,
            "match_status": r.Match.status,
            "home_score": r.Match.home_score,
            "away_score": r.Match.away_score,
            "handicap": r.Match.handicap,
            "start_time": r.Match.start_time.isoformat(),
            "choice": r.Bet.choice,
            "stake": r.Bet.stake,
            "points_earned": r.Bet.points_earned,
            "created_at": r.Bet.created_at.isoformat(),
        }
        for r in rows
    ]


@app.get("/api/v1/me/recharge-requests")
async def get_my_recharge_requests(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    rows = (
        await db.execute(
            select(PointRechargeRequest)
            .where(PointRechargeRequest.user_id == user.id)
            .order_by(PointRechargeRequest.created_at.desc())
        )
    ).scalars().all()
    return [_recharge_request_response(row) for row in rows]


@app.post("/api/v1/me/recharge-requests", status_code=201)
async def create_recharge_request(
    payload: PointRechargePayload,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    feature_settings = await _get_feature_settings(db)
    if not feature_settings.get("points_enabled", True):
        raise HTTPException(status_code=403, detail="Tính năng nạp điểm đang tạm tắt.")

    request = PointRechargeRequest(
        user_id=user.id,
        amount=payload.amount,
        status=PointRechargeStatus.pending,
    )
    try:
        db.add(request)
        await db.commit()
        await db.refresh(request)
    except Exception as e:
        await db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

    asyncio.create_task(notify_admin_recharge_request(request.id, user, request.amount))
    return {
        "message": "Yêu cầu nạp điểm đã được gửi và đang chờ admin xác nhận.",
        "request": _recharge_request_response(request),
    }


# GET /api/v1/matches — Danh sách trận đang mở kèo (upcoming + live)
@app.get("/api/v1/matches")
async def get_upcoming_matches(db: AsyncSession = Depends(get_db)):
    await _sync_match_statuses(db)
    # Subquery: tổng stake theo (match_id, choice)
    pool_q = (
        select(
            Bet.match_id,
            func.sum(case((Bet.choice == "HOME", Bet.stake), else_=0)).label("stakes_home"),
            func.sum(case((Bet.choice == "DRAW", Bet.stake), else_=0)).label("stakes_draw"),
            func.sum(case((Bet.choice == "AWAY", Bet.stake), else_=0)).label("stakes_away"),
            func.sum(Bet.stake).label("total_pool"),
        )
        .group_by(Bet.match_id)
        .subquery()
    )
    min_stake_q = (
        select(
            Bet.match_id.label("match_id"),
            func.min(Bet.stake).label("min_stake"),
        )
        .group_by(Bet.match_id)
        .subquery()
    )

    query = (
        select(
            Match,
            func.coalesce(pool_q.c.stakes_home, 0).label("stakes_home"),
            func.coalesce(pool_q.c.stakes_draw, 0).label("stakes_draw"),
            func.coalesce(pool_q.c.stakes_away, 0).label("stakes_away"),
            func.coalesce(pool_q.c.total_pool, 0).label("total_pool"),
            min_stake_q.c.min_stake.label("min_stake"),
        )
        .outerjoin(pool_q, Match.id == pool_q.c.match_id)
        .outerjoin(min_stake_q, Match.id == min_stake_q.c.match_id)
        .where(Match.status != MatchStatus.finished)
        .order_by(case((Match.status == MatchStatus.live, 0), else_=1), Match.start_time.asc())
    )

    rows = (await db.execute(query)).all()

    return [
        {
            "id": r.Match.id,
            "home_team": r.Match.home_team,
            "home_icon": r.Match.home_icon,
            "away_team": r.Match.away_team,
            "away_icon": r.Match.away_icon,
            "handicap": r.Match.handicap,
            "status": r.Match.status,
            "start_time": r.Match.start_time.isoformat(),
            "end_time": _match_effective_end_time(r.Match).isoformat(),
            "result_published": bool(r.Match.resolved_at),
            "stakes_home": r.stakes_home,
            "stakes_draw": r.stakes_draw,
            "stakes_away": r.stakes_away,
            "total_pool": r.total_pool,
            "min_stake": int(r.min_stake) if r.min_stake is not None else None,
        }
        for r in rows
    ]


# POST /api/v1/bets — Đặt cược (Transaction)
@app.post("/api/v1/bets-legacy", status_code=201)
async def place_bet(
    payload: BetPayload,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _sync_match_statuses(db)
    # Validate match
    match = (await db.execute(
        select(Match).where(Match.id == payload.match_id)
    )).scalars().first()

    if not match:
        raise HTTPException(status_code=404, detail="Trận đấu không tồn tại.")
    if match.status != MatchStatus.upcoming:
        raise HTTPException(status_code=400, detail="Trận này đã lên thớt.")

    min_stake = await _get_match_min_stake(db, payload.match_id)
    if min_stake is not None and payload.stake < min_stake:
        raise HTTPException(
            status_code=400,
            detail=f"Số điểm tối thiểu cho trận này là {_format_coins(min_stake)}.",
        )

    # Validate balance
    if user.total_points < payload.stake:
        raise HTTPException(status_code=400, detail="Số điểm không đủ.")

    # Kiểm tra đã cược chưa (1 user / 1 match)
    existing = (await db.execute(
        select(Bet).where(Bet.user_id == user.id, Bet.match_id == payload.match_id)
    )).scalars().first()
    if existing:
        raise HTTPException(status_code=409, detail="Lệnh xuống xác đã được ghi nhận. Không được quay xe!")

    try:
        balance_update = await db.execute(
            update(User)
            .where(User.id == user.id, User.total_points >= payload.stake)
            .values(total_points=User.total_points - payload.stake)
            .execution_options(synchronize_session=False)
        )
        if balance_update.rowcount != 1:
            await db.rollback()
            raise HTTPException(status_code=400, detail="Số điểm không đủ.")

        bet = Bet(
            user_id=user.id,
            match_id=payload.match_id,
            choice=payload.choice,
            stake=payload.stake,
            points_earned=None,
        )
        db.add(bet)
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Lệnh xuống xác đã được ghi nhận!")
    except HTTPException:
        raise
    except Exception as e:
        await db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

    await db.refresh(user)
    return {"message": "Chốt đơn thành công! Bắt đầu gáy thôi!", "remaining_points": user.total_points, "min_stake": min_stake}


# ─── GET /api/v1/matches/{match_id}/bets — Avatar Stack ──────────────────────
@app.get("/api/v1/matches/{match_id}/bets-legacy")
async def get_match_bets(match_id: int, db: AsyncSession = Depends(get_db)):
    """Trả về danh sách người đặt cược mỗi cửa (HOME/DRAW/AWAY) cho avatar stack."""
    query = (
        select(Bet, User)
        .join(User, Bet.user_id == User.id)
        .where(Bet.match_id == match_id)
        .order_by(Bet.created_at.asc())
    )
    rows = (await db.execute(query)).all()

    result = {"HOME": [], "DRAW": [], "AWAY": []}
    choice_counts = {"HOME": 0, "DRAW": 0, "AWAY": 0}

    for r in rows:
        choice_counts[r.Bet.choice] = choice_counts.get(r.Bet.choice, 0) + 1

    for r in rows:
        name = _user_display_name(r.User)
        initials = _user_initials(r.User)
        # Lone wolf: chỉ có 1 người đặt cửa này, trong khi cửa khác có nhiều hơn
        my_count = choice_counts.get(r.Bet.choice, 0)
        other_max = max(v for k, v in choice_counts.items() if k != r.Bet.choice)
        is_lone_wolf = my_count == 1 and other_max >= 3

        entry = {
            **_user_avatar_payload(r.User),
            "stake": r.Bet.stake,
            "is_lone_wolf": is_lone_wolf,
        }
        result[r.Bet.choice].append(entry)

    return result


# ─── GET /api/v1/matches/{match_id}/detail — Chi tiết trận và đặt cược ───────
@app.get("/api/v1/matches/{match_id:int}/detail")
async def get_match_detail(
    match_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _sync_match_statuses(db)
    match = (await db.execute(
        select(Match).where(Match.id == match_id)
    )).scalars().first()
    if not match:
        raise HTTPException(status_code=404, detail="Trận đấu không tồn tại.")
    return await _build_match_detail_payload(match=match, user=user, db=db)


@app.get("/api/v1/matches/latest-finished/detail")
async def get_latest_finished_match_detail(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    matches = (
        await db.execute(
            select(Match)
            .where(Match.status == MatchStatus.finished)
            .order_by(desc(func.coalesce(Match.resolved_at, Match.start_time)), desc(Match.id))
            .limit(5)
        )
    ).scalars().all()
    if not matches:
        raise HTTPException(status_code=404, detail="Chưa có trận nào hoàn tất.")

    return [
        await _build_match_detail_payload(match=match, user=user, db=db)
        for match in matches
    ]


# ─── GET /api/v1/leaderboard — Bảng Phong Thần ───────────────────────────────
@app.get("/api/v1/leaderboard")
async def get_leaderboard(db: AsyncSession = Depends(get_db)):
    """Top 20 users với badges tự động và trend indicator."""
    # Lấy top 20 theo total_points
    users_q = (
        select(User)
        .order_by(desc(User.total_points))
        .limit(20)
    )
    users = (await db.execute(users_q)).scalars().all()

    # Tính points_earned trong 24h gần nhất (trend)
    since = datetime.utcnow() - timedelta(hours=24)
    trend_q = (
        select(Bet.user_id, func.sum(Bet.points_earned).label("earned_24h"))
        .where(Bet.created_at >= since, Bet.points_earned > 0)
        .group_by(Bet.user_id)
    )
    trend_rows = (await db.execute(trend_q)).all()
    trend_map = {str(r.user_id): r.earned_24h for r in trend_rows}

    # Tính streak thua liên tiếp
    streak_q = (
        select(Bet.user_id, Bet.points_earned, Bet.created_at)
        .where(Bet.match_id.in_(
            select(Bet.match_id).where(
                Bet.match_id.in_(
                    select(Bet.match_id).scalar_subquery()
                )
            )
        ))
        .order_by(Bet.user_id, desc(Bet.created_at))
    )
    # Đơn giản hơn: lấy bets gần nhất của mỗi user
    all_bets_q = (
        select(Bet.user_id, Bet.points_earned, Bet.created_at)
        .where(Bet.points_earned.is_not(None))
        .order_by(Bet.user_id, desc(Bet.created_at))
    )
    all_bets = (await db.execute(all_bets_q)).all()

    # Group bets by user, tính streak
    from collections import defaultdict
    user_bets = defaultdict(list)
    for b in all_bets:
        user_bets[str(b.user_id)].append(b.points_earned)

    def calc_loss_streak(bets):
        streak = 0
        for earned in bets:
            if earned == 0:
                streak += 1
            else:
                break
        return streak

    # Kiểm tra "Nhà tiên tri": thắng khi chọn cửa thiểu số
    contrarian_q = (
        select(
            Bet.user_id,
            Bet.match_id,
            Bet.choice,
            Bet.points_earned,
        )
        .where(Bet.points_earned > 0)
    )
    contrarian_bets = (await db.execute(contrarian_q)).all()

    # Đếm số người đặt mỗi cửa của mỗi trận
    choice_count_q = (
        select(Bet.match_id, Bet.choice, func.count(Bet.id).label("cnt"))
        .group_by(Bet.match_id, Bet.choice)
    )
    choice_counts = (await db.execute(choice_count_q)).all()
    choice_map = {}  # (match_id, choice) -> count
    for cc in choice_counts:
        choice_map[(cc.match_id, cc.choice)] = cc.cnt

    contrarian_users = set()
    for cb in contrarian_bets:
        my_cnt = choice_map.get((cb.match_id, cb.choice), 1)
        all_cnts = [v for (mid, ch), v in choice_map.items() if mid == cb.match_id]
        if all_cnts and my_cnt == min(all_cnts) and my_cnt < max(all_cnts):
            contrarian_users.add(str(cb.user_id))

    leaderboard = []
    for idx, user in enumerate(users):
        rank = idx + 1
        uid = str(user.id)
        streak_loss = calc_loss_streak(user_bets.get(uid, []))
        earned_24h = trend_map.get(uid, 0)
        trend = "up" if earned_24h > 0 else "down" if streak_loss > 0 else "neutral"
        is_contrarian = uid in contrarian_users

        # Badge logic
        if rank == 1:
            badge = {"label": "Đại gia", "emoji": "🤑", "color": "gold"}
        elif rank == len(users):
            badge = {"label": "Báo thủ", "emoji": "🐣", "color": "gray"}
        elif is_contrarian:
            badge = {"label": "Nhà tiên tri", "emoji": "🔮", "color": "purple"}
        elif streak_loss >= 3:
            badge = {"label": "Cứu rỗi", "emoji": "🙏", "color": "red"}
        else:
            badge = None

        leaderboard.append({
            "id": str(user.id),
            "rank": rank,
            "name": _user_display_name(user),
            "display_name": _user_display_name(user),
            "total_points": user.total_points,
            "avatar_url": user.avatar_url,
            "avatar_color": user.avatar_color or "#6366f1",
            "initials": _user_initials(user),
            "trend": trend,
            "earned_24h": earned_24h,
            "streak_loss": streak_loss,
            "badge": badge,
        })

    return leaderboard


# ─── GET /api/v1/activity-feed — Live Ticker ──────────────────────────────────
@app.get("/api/v1/activity-feed")
async def get_activity_feed(db: AsyncSession = Depends(get_db)):
    """20 hoạt động cược gần nhất để hiển thị trong Live Ticker."""
    query = (
        select(Bet, User, Match)
        .join(User, Bet.user_id == User.id)
        .join(Match, Bet.match_id == Match.id)
        .order_by(desc(Bet.created_at))
        .limit(20)
    )
    rows = (await db.execute(query)).all()

    TEMPLATES = [
        "🔥 {name} vừa tất tay {stake} vào {team}",
        "💸 {name} đặt {stake} chọn {team}",
        "🎯 {name} tin tưởng {team} với {stake}",
        "🤡 {name} lại tiếp tục tin tưởng {team}",
        "😤 {name} quyết tâm với {team} — {stake}",
        "🃏 {name} bài ngửa {stake} vào {team}",
        "💰 {name} cược đậm {stake} vào {team}",
        "💪 {name} vô {stake} vào {team}, liệu có nhổ được xe?",
        "👍 {name} xuống xác {stake} vào {team}"
    ]

    CHOICE_LABELS = {"HOME": "Chủ nhà", "DRAW": "Hòa", "AWAY": "Khách"}

    activities = []
    for r in rows:
        name = _user_display_name(r.User)
        team = (
            r.Match.home_team if r.Bet.choice == "HOME"
            else r.Match.away_team if r.Bet.choice == "AWAY"
            else CHOICE_LABELS["DRAW"]
        )
        tpl = random.choice(TEMPLATES)
        # Dùng seed ổn định để template không đổi mỗi lần refresh
        seed = hash(f"{r.Bet.id}{r.Bet.created_at}")
        tpl = TEMPLATES[abs(seed) % len(TEMPLATES)]
        text = tpl.format(name=name, stake=_format_coins(r.Bet.stake), team=team)
        activities.append({
            "text": text,
            "time": r.Bet.created_at.isoformat(),
        })

    return activities


@app.get("/api/v1/admin/overview")
async def get_admin_overview(admin_user: User = Depends(get_admin_user), db: AsyncSession = Depends(get_db)):
    await _sync_match_statuses(db)
    total_users = (await db.execute(select(func.count()).select_from(User))).scalar_one()
    total_matches = (await db.execute(select(func.count()).select_from(Match))).scalar_one()
    upcoming_matches = (
        await db.execute(select(func.count()).select_from(Match).where(Match.status == MatchStatus.upcoming))
    ).scalar_one()
    total_bets = (await db.execute(select(func.count()).select_from(Bet))).scalar_one()
    total_points = (await db.execute(select(func.coalesce(func.sum(User.total_points), 0)))).scalar_one()
    feature_settings = await _get_feature_settings(db)

    return {
        "total_users": total_users,
        "total_matches": total_matches,
        "upcoming_matches": upcoming_matches,
        "total_bets": total_bets,
        "total_points": total_points,
        "features": feature_settings,
    }


@app.get("/api/v1/admin/settings")
async def get_admin_settings(admin_user: User = Depends(get_admin_user), db: AsyncSession = Depends(get_db)):
    return await _get_feature_settings(db)


@app.post("/api/v1/admin/settings")
async def update_admin_settings(
    payload: AdminSettingsPayload,
    admin_user: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    await _ensure_default_settings(db)
    settings = (await db.execute(select(AppSetting))).scalars().all()
    settings_map = {item.key: item for item in settings}

    for key, value in {
        "points_enabled": payload.points_enabled,
    }.items():
        setting = settings_map.get(key)
        if not setting:
            setting = AppSetting(key=key, value="1" if value else "0")
        else:
            setting.value = "1" if value else "0"
        db.add(setting)

    await db.commit()
    return await _get_feature_settings(db)


@app.get("/api/v1/admin/users")
async def get_admin_users(
    q: str = "",
    admin_user: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    users = (await db.execute(select(User).order_by(desc(User.created_at)))).scalars().all()
    bets = (await db.execute(select(Bet).order_by(desc(Bet.created_at)))).scalars().all()

    search = q.strip().lower()
    filtered_users = [
        user for user in users
        if not search
        or search in user.email.lower()
        or search in (user.display_name or "").lower()
    ]

    bets_by_user: dict[str, list[Bet]] = {}
    for bet in bets:
        bets_by_user.setdefault(str(bet.user_id), []).append(bet)

    return [
        {
            "id": str(user.id),
            "email": user.email,
            "display_name": user.display_name,
            "total_points": user.total_points,
            "created_at": user.created_at.isoformat() if user.created_at else None,
            "last_bet_at": bets_by_user[str(user.id)][0].created_at.isoformat() if bets_by_user.get(str(user.id)) else None,
            "bet_count": len(bets_by_user.get(str(user.id), [])),
            "win_count": sum(
                1
                for bet in bets_by_user.get(str(user.id), [])
                if (bet.points_earned or 0) > 0
            ),
            "loss_count": sum(
                1
                for bet in bets_by_user.get(str(user.id), [])
                if bet.points_earned == 0
            ),
            "is_admin": user.email.strip().lower() in ADMIN_EMAILS,
        }
        for user in filtered_users
    ]


@app.post("/api/v1/admin/users/{user_id}/points")
async def update_admin_user_points(
    user_id: UUID,
    payload: AdminUserPointsPayload,
    admin_user: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    user = (await db.execute(select(User).where(User.id == user_id))).scalars().first()
    if not user:
        raise HTTPException(status_code=404, detail="Người dùng không tồn tại.")

    user.total_points = payload.total_points
    db.add(user)
    await db.commit()
    await db.refresh(user)

    return {
        "id": str(user.id),
        "total_points": user.total_points,
    }


# GET /api/v1/admin/matches — Danh sách tất cả trận đấu cho Admin
def _match_response(match: Match):
    return {
        "id": match.id,
        "home_team": match.home_team,
        "home_icon": match.home_icon,
        "away_team": match.away_team,
        "away_icon": match.away_icon,
        "home_score": match.home_score,
        "away_score": match.away_score,
        "handicap": match.handicap,
        "status": match.status,
        "start_time": match.start_time.isoformat(),
        "end_time": _match_effective_end_time(match).isoformat() if match.start_time else None,
        "result_published": bool(getattr(match, "resolved_at", None)),
        "resolved_at": match.resolved_at.isoformat() if getattr(match, "resolved_at", None) else None,
    }


def _choice_label(choice: Optional[str]) -> str:
    return CHOICE_LABELS.get(choice or "", choice or "Không rõ")


def _user_display_name(user: User) -> str:
    return user.display_name or user.email.split("@")[0]


def _user_initials(user: User) -> str:
    return _user_display_name(user)[:2].upper()


def _user_avatar_payload(user: User) -> dict:
    display_name = _user_display_name(user)
    return {
        "name": display_name,
        "display_name": display_name,
        "avatar_url": user.avatar_url,
        "avatar_color": user.avatar_color or "#6366f1",
        "initials": _user_initials(user),
    }


def _user_badge_payload(
    *,
    rank: Optional[int],
    total_users: int,
    streak_loss: int,
    is_contrarian: bool,
) -> Optional[dict]:
    if rank == 1:
        return {"label": "Đại gia", "emoji": "🤑", "color": "gold"}
    if rank == total_users:
        return {"label": "Báo thủ", "emoji": "🐣", "color": "gray"}
    if is_contrarian:
        return {"label": "Nhà tiên tri", "emoji": "🔮", "color": "purple"}
    if streak_loss >= 3:
        return {"label": "Cứu rỗi", "emoji": "🙏", "color": "red"}
    return None


async def _build_user_badge_for_profile(user: User, db: AsyncSession) -> Optional[dict]:
    ordered_ids = (
        await db.execute(
            select(User.id).order_by(desc(User.total_points), User.id.asc())
        )
    ).scalars().all()
    total_users = len(ordered_ids)
    if not total_users:
        return None

    rank = next((idx + 1 for idx, uid in enumerate(ordered_ids) if uid == user.id), None)
    if rank is None:
        return None

    since = datetime.utcnow() - timedelta(hours=24)
    trend_q = (
        select(func.sum(Bet.points_earned))
        .where(Bet.user_id == user.id, Bet.created_at >= since, Bet.points_earned > 0)
    )
    earned_24h = (await db.execute(trend_q)).scalar() or 0

    recent_bets = (
        await db.execute(
            select(Bet.points_earned)
            .where(Bet.user_id == user.id, Bet.points_earned.is_not(None))
            .order_by(Bet.created_at.desc())
        )
    ).scalars().all()

    streak_loss = 0
    for earned in recent_bets:
        if earned == 0:
            streak_loss += 1
        else:
            break

    winning_bets = (
        await db.execute(
            select(Bet.match_id, Bet.choice)
            .where(Bet.user_id == user.id, Bet.points_earned > 0)
        )
    ).all()
    is_contrarian = False
    for bet in winning_bets:
        counts = (
            await db.execute(
                select(Bet.choice, func.count(Bet.id).label("cnt"))
                .where(Bet.match_id == bet.match_id)
                .group_by(Bet.choice)
            )
        ).all()
        if not counts:
            continue
        counts_map = {row.choice: row.cnt for row in counts}
        my_cnt = counts_map.get(bet.choice, 0)
        all_cnts = list(counts_map.values())
        if all_cnts and my_cnt == min(all_cnts) and my_cnt < max(all_cnts):
            is_contrarian = True
            break

    return _user_badge_payload(
        rank=rank,
        total_users=total_users,
        streak_loss=streak_loss,
        is_contrarian=is_contrarian,
    )


def _recharge_request_response(request: PointRechargeRequest, user: Optional[User] = None, admin: Optional[User] = None) -> dict:
    payload = {
        "id": request.id,
        "amount": request.amount,
        "status": request.status,
        "created_at": request.created_at.isoformat(),
        "approved_at": request.approved_at.isoformat() if request.approved_at else None,
    }
    if user:
        payload["user"] = {
            "id": str(user.id),
            "email": user.email,
            **_user_avatar_payload(user),
            "total_points": user.total_points,
        }
    if admin:
        payload["approved_by"] = {
            "id": str(admin.id),
            "email": admin.email,
            "display_name": _user_display_name(admin),
        }
    return payload


def _stable_pick(options, seed: str) -> str:
    if not options:
        return ""
    digest = hashlib.md5(seed.encode("utf-8")).hexdigest()
    return options[int(digest, 16) % len(options)]


def _format_reward_label(outcome: str, stake: int, points_earned: Optional[int]) -> str:
    if outcome == "WIN":
        return f"+{_format_coins(int(points_earned or 0))}"
    if outcome == "LOSE":
        return "0d"
    if outcome == "REFUND":
        return f"Hoàn {_format_coins(int(stake))}"
    return "Chờ kết quả"


def _build_detail_quote(
    *,
    match: Match,
    choice: str,
    outcome: str,
    stake: int,
    points_earned: Optional[int],
    winning_choice: Optional[str],
    name: str,
) -> str:
    choice_text = _choice_label(choice)
    winner_text = _choice_label(winning_choice)
    quote_bank = {
        "WIN": [
            "{name} ôm đúng cửa {choice}. Hôm nay bảng điểm phải tự chỉnh lại thái độ.",
            "{name} chọn {choice} chuẩn như xem trước kết quả. Đám đông xin phép học theo.",
            "{name} vào kèo {choice} rất gọn. Trận này trực giác đã thắng tranh cãi.",
        ],
        "LOSE": [
            "{name} chọn {choice} khá tự tin, nhưng kết quả lại trả lời theo kiểu rất thẳng.",
            "{name} vừa trải nghiệm một pha kèo không chiều lòng niềm tin.",
            "{name} đi cửa {choice} hơi sớm một nhịp. Hôm nay trực giác xin nghỉ phép.",
        ],
        "REFUND": [
            "{name} gặp kèo hoàn điểm. Ít ra ví vẫn nguyên, tinh thần cũng đỡ đau.",
            "{name} đi một vòng rồi quay lại vạch xuất phát. Trận này công bằng đến mức hơi buồn cười.",
            "{name} không mất điểm nhưng cũng chưa kịp trêu ai. Kèo này đúng kiểu hòa cho tất cả.",
        ],
        "PENDING": [
            "{name} đang chờ kèo nổ. Cửa {choice} mà lên tiếng thì câu chuyện sẽ vui hơn nhiều.",
            "{name} đã vào cửa {choice}, giờ chỉ còn chờ bảng điểm quyết định phần hài hước.",
            "{name} chọn {choice}, còn trận đấu thì giữ kịch tính khá lâu.",
        ],
    }
    seed = f"{match.id}:{name}:{choice}:{outcome}:{stake}:{points_earned or 0}:{winning_choice or ''}"
    template = _stable_pick(quote_bank.get(outcome, quote_bank["PENDING"]), seed)
    return template.format(name=name, choice=choice_text, winner=winner_text, stake=_format_coins(stake))


def _build_headline_quote(
    *,
    match: Match,
    settlement: dict,
    summary: dict,
) -> str:
    if settlement.get("is_finished") and not settlement.get("result_published"):
        return _stable_pick(
            [
                "Trận đã khép lại theo lịch, hiện đang chờ công bố kết quả chính thức.",
                "90 phút đã qua, nhưng bảng điểm vẫn còn chờ cú nhấp chuột từ admin.",
                "Kèo đã hết giờ, kết quả vẫn đang được giữ ở trạng thái chờ xác nhận.",
                "Trận này đã chốt giờ thi đấu, còn tỉ số thì đợi người có quyền công bố.",
                "Người chơi tạm đứng xem, vì kết quả chính thức vẫn chưa được mở khóa.",
            ],
            f"{match.id}:pending_result",
        )

    if settlement["is_finished"]:
        if settlement["refunded"]:
            return _stable_pick(
                [
                    "Kèo này hoàn tiền, nên ai cũng rời bàn với vẻ mặt khá lịch sự.",
                    "Trận đã xong nhưng không cửa nào đủ lực để giữ lại màn khịa dài lâu.",
                    "Không ai ăn đủ, thế là cuộc vui tạm dừng trong thế cân bằng hơi buồn cười.",
                    "Tưởng thế nào, đá hùng hục 90 phút xong trả lại tiền. Quần áo ai nấy mặc, nhà ai nấy về.",
                    "Cả làng huề vốn! Những kẻ mạnh miệng nhất trước giờ lăn bóng nay bỗng trở nên hiền lành lạ thường.",
                    "Một trận cầu tốn calo của cầu thủ và tốn cả thanh xuân của người xem. Chốt lại: Huề tiền!",
                    "Hệ thống trả lại tiền đây, anh em cất đi mai chơi tiếp, nay chưa ai đủ tư cách gáy đâu.",
                    "Điểm về lại ví, tình anh em chưa rạn nứt. Hôm nay vũ trụ độ cho cả nhóm khỏi mất tiền đấy.",
                    "Nhìn bảng điểm im lìm mà thấy thương. Chuẩn bị văn mẫu khịa nhau cả ngày xong cuối cùng phải xóa vội.",
                    "Tiền vẫn trong túi, đồng nghiệp vẫn nhìn mặt nhau. Một cái kết nhạt nhẽo nhưng an toàn!",
                    "Hòa cả làng! Thôi anh em thu dọn hiện trường, nay không có ai ra đê cũng chẳng ai lên đỉnh."
                ],
                f"{match.id}:refund",
            )

        winner_choice = settlement["winning_choice"] or "HOME"
        winner_text = _choice_label(winner_choice)
        return _stable_pick(
            [
                "{winner} đã lên tiếng. Người ôm đúng cửa hôm nay nói ít nhưng cười nhiều.",
                "Kết quả ngả về {winner}. Bên kia chỉ còn cách tự an ủi bằng kinh nghiệm.",
                "{winner} thắng trận này, và đám đông vừa học thêm một bài về niềm tin.",
                "Chúc mừng các cổ đông {winner}. Nhận tiền đi kìa, tiền lấy từ túi anh em tiêu lúc nào cũng sướng.",
                "{winner} chốt hạ! Những ai nằm cửa này xin phép được gáy to từ giờ đến sáng mai.",
                "Hệ thống đang chuyển tiền từ những trái tim tan vỡ sang cho fan {winner}. Đề nghị bên thua không khóc.",
                "90 phút bão táp kết thúc với chiến thắng cho {winner}. Mấy anh nằm cửa ngược chắc đang lẳng lặng xóa văn mẫu.",
                "Ánh sáng chân lý hôm nay gọi tên {winner}. Bên kia đá xước cả móng chân cũng không gánh nổi sổ đỏ của anh em.",
                "Tiếng thở dài của đám đông làm nền cho nụ cười của người chọn {winner}. Bóng đá mà, cay lắm!",
                "{winner} mang tiền về cho mẹ, còn đội bạn thì mang nợ về cho anh em.",
                "Ai bảo cờ bạc là may rủi? Nhìn mấy anh trúng quả {winner} kìa, toàn 'phân tích chiến thuật' cả đấy!",
                "Quyết định thuộc về {winner}. Người ăn thì vỗ đùi đen đét, kẻ thua thì lại bắt đầu bài ca đổ tại VAR."
            ],
            f"{match.id}:{winner_choice}",
        ).format(
            winner=winner_text,
            home=match.home_team,
            away=match.away_team,
            score=f"{match.home_score}-{match.away_score}",
        )

    dominant_choice = sorted(
        summary.items(),
        key=lambda item: (-item[1]["stake"], -item[1]["count"], item[0]),
    )[0][0]
    dominant_text = _choice_label(dominant_choice)
    return _stable_pick(
        [
            "Cửa {choice} đang đông khách nhất. Đám đông đang chờ xem ai sẽ cười sau cùng.",
            "Quỹ đang nghiêng về {choice}. Trận này nhìn là biết sẽ còn nhiều lời ra tiếng vào.",
            "{choice} đang được chú ý nhất, nhưng bảng điểm thì vẫn thích tạo bất ngờ.",
        ],
        f"{match.id}:pending:{dominant_choice}",
    ).format(
        choice=dominant_text,
        home=match.home_team,
        away=match.away_team,
    )


async def _build_match_detail_payload(
    *,
    match: Match,
    user: User,
    db: AsyncSession,
):
    query = (
        select(Bet, User)
        .join(User, Bet.user_id == User.id)
        .where(Bet.match_id == match.id)
        .order_by(Bet.created_at.asc())
    )
    rows = (await db.execute(query)).all()

    summary = {
        "HOME": {"stake": 0, "count": 0},
        "DRAW": {"stake": 0, "count": 0},
        "AWAY": {"stake": 0, "count": 0},
    }
    bettors = {"HOME": [], "DRAW": [], "AWAY": []}

    for row in rows:
        choice = row.Bet.choice
        summary[choice]["stake"] += row.Bet.stake
        summary[choice]["count"] += 1

    is_finished = match.status == MatchStatus.finished
    result_published = is_finished and bool(match.resolved_at)
    adjusted_home = None
    adjusted_away = None
    winning_choice = None
    if result_published:
        adjusted_home = match.home_score + match.handicap
        adjusted_away = match.away_score
        if adjusted_home > adjusted_away:
            winning_choice = "HOME"
        elif adjusted_home < adjusted_away:
            winning_choice = "AWAY"
        else:
            winning_choice = "DRAW"

    total_pool = sum(summary[ch]["stake"] for ch in summary)
    stakes_on_winner = summary[winning_choice]["stake"] if winning_choice else 0
    has_bets = bool(rows)
    refunded = result_published and has_bets and (stakes_on_winner == 0)

    settlement = {
        "is_finished": is_finished,
        "result_published": result_published,
        "winning_choice": winning_choice if result_published else None,
        "winning_choice_label": _choice_label(winning_choice) if result_published else None,
        "adjusted_home_score": adjusted_home if result_published else None,
        "adjusted_away_score": adjusted_away if result_published else None,
        "adjusted_score": f"{adjusted_home}-{adjusted_away}" if result_published else None,
        "score": f"{match.home_score}-{match.away_score}" if result_published else None,
        "refunded": refunded,
        "winner_count": 0,
        "loser_count": 0,
        "refund_count": 0,
        "headline_quote": None,
    }

    for row in rows:
        if not result_published:
            outcome = "PENDING"
        elif refunded:
            outcome = "REFUND"
        elif row.Bet.choice == winning_choice:
            outcome = "WIN"
        else:
            outcome = "LOSE"

        if outcome == "WIN":
            settlement["winner_count"] += 1
        elif outcome == "LOSE":
            settlement["loser_count"] += 1
        elif outcome == "REFUND":
            settlement["refund_count"] += 1

        user_payload = _user_avatar_payload(row.User)
        bettors[row.Bet.choice].append({
            **user_payload,
            "stake": row.Bet.stake,
            "created_at": row.Bet.created_at.isoformat(),
            "is_lone_wolf": summary[row.Bet.choice]["count"] == 1 and max(
                summary[ch]["count"] for ch in summary if ch != row.Bet.choice
            ) >= 3,
            "outcome": outcome,
            "outcome_label": OUTCOME_LABELS[outcome],
            "quote": _build_detail_quote(
                match=match,
                choice=row.Bet.choice,
                outcome=outcome,
                stake=row.Bet.stake,
                points_earned=row.Bet.points_earned,
                winning_choice=winning_choice if result_published else None,
                name=user_payload["name"],
            ),
            "reward_label": _format_reward_label(outcome, row.Bet.stake, row.Bet.points_earned),
            "points_earned": row.Bet.points_earned,
        })

    my_row = next((row for row in rows if row.User.id == user.id), None)
    my_bet = None
    if my_row:
        if not result_published:
            my_outcome = "PENDING"
        elif refunded:
            my_outcome = "REFUND"
        elif my_row.Bet.choice == winning_choice:
            my_outcome = "WIN"
        else:
            my_outcome = "LOSE"

        my_bet = {
            "choice": my_row.Bet.choice,
            "stake": my_row.Bet.stake,
            "points_earned": my_row.Bet.points_earned,
            "created_at": my_row.Bet.created_at.isoformat(),
            "outcome": my_outcome,
            "outcome_label": OUTCOME_LABELS[my_outcome],
            "quote": _build_detail_quote(
                match=match,
                choice=my_row.Bet.choice,
                outcome=my_outcome,
                stake=my_row.Bet.stake,
                points_earned=my_row.Bet.points_earned,
                winning_choice=winning_choice if result_published else None,
                name=_user_display_name(my_row.User),
            ),
            "reward_label": _format_reward_label(my_outcome, my_row.Bet.stake, my_row.Bet.points_earned),
        }

    settlement["headline_quote"] = _build_headline_quote(
        match=match,
        settlement=settlement,
        summary=summary,
    )

    return {
        "match": _match_response(match),
        "pool": {
            "total_pool": total_pool,
            "home_stakes": summary["HOME"]["stake"],
            "draw_stakes": summary["DRAW"]["stake"],
            "away_stakes": summary["AWAY"]["stake"],
            "home_count": summary["HOME"]["count"],
            "draw_count": summary["DRAW"]["count"],
            "away_count": summary["AWAY"]["count"],
        },
        "settlement": settlement,
        "bettors": bettors,
        "my_bet": my_bet,
    }


@app.get("/api/v1/admin/matches")
async def get_all_matches(admin_user: User = Depends(get_admin_user), db: AsyncSession = Depends(get_db)):
    await _sync_match_statuses(db)
    query = select(Match).order_by(Match.start_time.asc())
    rows = (await db.execute(query)).scalars().all()
    return [_match_response(r) for r in rows]


@app.get("/api/v1/admin/recharge-requests")
async def get_recharge_requests(admin_user: User = Depends(get_admin_user), db: AsyncSession = Depends(get_db)):
    rows = (
        await db.execute(
            select(PointRechargeRequest, User)
            .join(User, PointRechargeRequest.user_id == User.id)
            .order_by(
                case((PointRechargeRequest.status == PointRechargeStatus.pending, 0), else_=1),
                PointRechargeRequest.created_at.desc(),
            )
        )
    ).all()
    return [_recharge_request_response(request, user) for request, user in rows]


@app.post("/api/v1/admin/recharge-requests/{request_id}/approve")
async def approve_recharge_request(
    request_id: int,
    admin_user: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    request = (
        await db.execute(select(PointRechargeRequest).where(PointRechargeRequest.id == request_id))
    ).scalars().first()
    if not request:
        raise HTTPException(status_code=404, detail="Yêu cầu nạp điểm không tồn tại.")
    if request.status != PointRechargeStatus.pending:
        raise HTTPException(status_code=409, detail="Yêu cầu này đã được xử lý.")

    try:
        approved_at = _local_now_naive()
        status_update = await db.execute(
            update(PointRechargeRequest)
            .where(
                PointRechargeRequest.id == request_id,
                PointRechargeRequest.status == PointRechargeStatus.pending,
            )
            .values(
                status=PointRechargeStatus.approved,
                approved_at=approved_at,
                approved_by_user_id=admin_user.id,
            )
            .execution_options(synchronize_session=False)
        )
        if status_update.rowcount != 1:
            await db.rollback()
            raise HTTPException(status_code=409, detail="Yêu cầu này đã được xử lý.")

        await db.execute(
            update(User)
            .where(User.id == request.user_id)
            .values(total_points=User.total_points + request.amount)
            .execution_options(synchronize_session=False)
        )
        await db.commit()
        await db.refresh(request)
    except HTTPException:
        raise
    except Exception as e:
        await db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

    user = (
        await db.execute(select(User).where(User.id == request.user_id))
    ).scalars().first()
    if user:
        await db.refresh(user)
    return {
        "message": "Đã xác nhận và cộng điểm cho user.",
        "request": _recharge_request_response(request, user, admin_user),
    }


# POST /api/v1/admin/matches — Thêm trận đấu mới
@app.post("/api/v1/admin/matches", status_code=201)
async def create_match(
    payload: MatchPayload,
    admin_user: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    if payload.status == MatchStatus.finished:
        raise HTTPException(status_code=400, detail="Hãy dùng chức năng giải trận để kết thúc trận.")
    if payload.end_time <= payload.start_time:
        raise HTTPException(status_code=400, detail="Giờ kết thúc phải sau giờ bắt đầu.")

    try:
        match = Match(
            home_team=payload.home_team.strip(),
            home_icon=(payload.home_icon or "").strip() or None,
            away_team=payload.away_team.strip(),
            away_icon=(payload.away_icon or "").strip() or None,
            handicap=payload.handicap,
            status=payload.status,
            start_time=payload.start_time,
            end_time=payload.end_time,
        )
        db.add(match)
        await db.commit()
        await db.refresh(match)
    except Exception as e:
        await db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

    return {"message": "Đã thêm trận đấu.", "match": _match_response(match)}


def _clean_csv_value(row: dict, key: str, default: str = "") -> str:
    value = row.get(key, default)
    if value is None:
        return default
    return str(value).strip()


def _parse_csv_datetime(value: str) -> datetime:
    value = value.strip()
    if not value:
        raise ValueError("start_time is required")
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M"):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    raise ValueError("Invalid start_time format")


def _parse_optional_int(value: str, default: int = 0) -> int:
    if value == "":
        return default
    return int(float(value))


def _parse_optional_float(value: str, default: float = 0.0) -> float:
    if value == "":
        return default
    return float(value)


@app.post("/api/v1/admin/matches/import-csv")
async def import_matches_csv(
    file: UploadFile = File(...),
    admin_user: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    filename = (file.filename or "").lower()
    if not filename.endswith(".csv"):
        raise HTTPException(status_code=400, detail="Chỉ chấp nhận file CSV.")

    contents = await file.read()
    if len(contents) > 2 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File CSV tối đa 2MB.")

    try:
        text = contents.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="File CSV cần dùng mã hóa UTF-8.")

    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise HTTPException(status_code=400, detail="File CSV không có header.")

    imported = 0
    created = 0
    updated = 0
    errors = []

    try:
        for line_no, row in enumerate(reader, start=2):
            if not any(str(v or "").strip() for v in row.values()):
                continue

            try:
                home_team = _clean_csv_value(row, "home_team")
                away_team = _clean_csv_value(row, "away_team")
                if not home_team or not away_team:
                    raise ValueError("home_team and away_team are required")

                status_value = _clean_csv_value(row, "status", MatchStatus.upcoming.value) or MatchStatus.upcoming.value
                status = MatchStatus(status_value)
                if status == MatchStatus.finished:
                    raise ValueError("Use resolve match flow instead of importing finished status")
                start_time = _parse_csv_datetime(
                    _clean_csv_value(row, "start_time") or _clean_csv_value(row, "start_time_ict")
                )
                end_time_value = _clean_csv_value(row, "end_time")
                end_time = _parse_csv_datetime(end_time_value) if end_time_value else start_time + MATCH_DEFAULT_DURATION
                if end_time <= start_time:
                    raise ValueError("end_time must be after start_time")
                home_score = _parse_optional_int(_clean_csv_value(row, "home_score"), 0)
                away_score = _parse_optional_int(_clean_csv_value(row, "away_score"), 0)
                handicap = _parse_optional_float(_clean_csv_value(row, "handicap"), 0.0)
                home_icon = _clean_csv_value(row, "home_icon") or None
                away_icon = _clean_csv_value(row, "away_icon") or None
                raw_id = _clean_csv_value(row, "id")

                match = None
                if raw_id:
                    match = (
                        await db.execute(select(Match).where(Match.id == int(raw_id)))
                    ).scalars().first()

                if match:
                    match.home_team = home_team
                    match.away_team = away_team
                    match.home_icon = home_icon
                    match.away_icon = away_icon
                    match.home_score = home_score
                    match.away_score = away_score
                    match.handicap = handicap
                    match.status = status
                    match.start_time = start_time
                    match.end_time = end_time
                    updated += 1
                else:
                    match_kwargs = {
                        "home_team": home_team,
                        "away_team": away_team,
                        "home_icon": home_icon,
                        "away_icon": away_icon,
                        "home_score": home_score,
                        "away_score": away_score,
                        "handicap": handicap,
                        "status": status,
                        "start_time": start_time,
                        "end_time": end_time,
                    }
                    if raw_id:
                        match_kwargs["id"] = int(raw_id)
                    match = Match(**match_kwargs)
                    created += 1

                db.add(match)
                imported += 1
            except Exception as e:
                errors.append({"line": line_no, "error": str(e)})
                if len(errors) >= 10:
                    break

        if errors:
            await db.rollback()
            return {
                "message": "Import thất bại. Chưa có trận nào được lưu.",
                "imported": 0,
                "created": 0,
                "updated": 0,
                "errors": errors,
            }

        await db.commit()
    except Exception as e:
        await db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

    return {
        "message": f"Đã import {imported} trận đấu.",
        "imported": imported,
        "created": created,
        "updated": updated,
        "errors": [],
    }


# POST /api/v1/admin/matches/{match_id}/update — Cập nhật thông tin trận
@app.post("/api/v1/admin/matches/{match_id}/update")
async def update_match(
    match_id: int,
    payload: MatchPayload,
    admin_user: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    match = (await db.execute(select(Match).where(Match.id == match_id))).scalars().first()
    if not match:
        raise HTTPException(status_code=404, detail="Trận đấu không tồn tại.")
    if match.status == MatchStatus.finished:
        raise HTTPException(status_code=400, detail="Không thể sửa trận đã giải.")
    if payload.status == MatchStatus.finished:
        raise HTTPException(status_code=400, detail="Hãy dùng chức năng giải trận để kết thúc trận.")
    if payload.end_time <= payload.start_time:
        raise HTTPException(status_code=400, detail="Giờ kết thúc phải sau giờ bắt đầu.")

    try:
        match.home_team = payload.home_team.strip()
        match.home_icon = (payload.home_icon or "").strip() or None
        match.away_team = payload.away_team.strip()
        match.away_icon = (payload.away_icon or "").strip() or None
        match.handicap = payload.handicap
        match.status = payload.status
        match.start_time = payload.start_time
        match.end_time = payload.end_time
        db.add(match)
        await db.commit()
        await db.refresh(match)
    except Exception as e:
        await db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

    return {"message": "Đã cập nhật trận đấu.", "match": _match_response(match)}


# POST /api/v1/admin/matches/{match_id}/delete — Xóa trận chưa có cược
@app.post("/api/v1/admin/matches/{match_id}/delete")
async def delete_match(
    match_id: int,
    admin_user: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    match = (await db.execute(select(Match).where(Match.id == match_id))).scalars().first()
    if not match:
        raise HTTPException(status_code=404, detail="Trận đấu không tồn tại.")

    bet_count = (await db.execute(
        select(func.count(Bet.id)).where(Bet.match_id == match_id)
    )).scalar_one()
    if bet_count:
        raise HTTPException(status_code=400, detail="Không thể xóa trận đã có người đặt cược.")

    try:
        await db.delete(match)
        await db.commit()
    except Exception as e:
        await db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

    return {"message": "Đã xóa trận đấu."}


# POST /api/v1/admin/resolve-match/{match_id} — Giải trận
@app.post("/api/v1/admin/resolve-match/{match_id}")
async def resolve_match(
    match_id: int,
    payload: ResolvePayload,
    admin_user: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    await _sync_match_statuses(db)
    match = (await db.execute(
        select(Match).where(Match.id == match_id)
    )).scalars().first()

    if not match:
        raise HTTPException(status_code=404, detail="Trận đấu không tồn tại.")
    if match.status != MatchStatus.finished:
        raise HTTPException(status_code=400, detail="Trận chưa kết thúc, chưa thể giải.")
    if match.resolved_at is not None:
        raise HTTPException(status_code=400, detail="Trận đã được giải trước đó.")

    try:
        # Lưu score
        match.home_score = payload.home_score
        match.away_score = payload.away_score

        # Tính adjusted score với handicap
        adjusted_home = payload.home_score + match.handicap
        adjusted_away = payload.away_score

        if adjusted_home > adjusted_away:
            winning_choice = "HOME"
        elif adjusted_home < adjusted_away:
            winning_choice = "AWAY"
        else:
            winning_choice = "DRAW"

        # Lấy tất cả bets của trận
        bets = (await db.execute(
            select(Bet).where(Bet.match_id == match_id)
        )).scalars().all()

        total_pool = sum(b.stake for b in bets)
        winning_bets = [b for b in bets if b.choice == winning_choice]
        stakes_on_winner = sum(b.stake for b in winning_bets)
        refunded = not winning_bets or stakes_on_winner == 0

        if refunded:
            # Refund tất cả nếu không có ai cược đúng
            for bet in bets:
                bet.points_earned = None
                db.add(bet)
                user_q = (await db.execute(
                    select(User).where(User.id == bet.user_id)
                )).scalars().first()
                if user_q:
                    user_q.total_points += bet.stake
                    db.add(user_q)
        else:
            for bet in bets:
                bet.points_earned = 0
                db.add(bet)

            allocations = []
            total_allocated = 0
            pool_decimal = Decimal(total_pool)
            winner_decimal = Decimal(stakes_on_winner)

            for bet in winning_bets:
                exact_reward = (pool_decimal * Decimal(bet.stake)) / winner_decimal
                reward = int(exact_reward.to_integral_value(rounding=ROUND_DOWN))
                allocations.append((bet, reward, exact_reward - Decimal(reward)))
                total_allocated += reward

            remainder = total_pool - total_allocated
            allocations.sort(key=lambda item: (-item[2], -item[0].stake, item[0].id))

            for index, (bet, reward, _) in enumerate(allocations):
                final_reward = reward + (1 if index < remainder else 0)
                bet.points_earned = final_reward
                db.add(bet)

                user_q = (await db.execute(
                    select(User).where(User.id == bet.user_id)
                )).scalars().first()
                if user_q:
                    user_q.total_points += final_reward
                    db.add(user_q)

        match.status = MatchStatus.finished
        match.resolved_at = _local_now_naive()
        db.add(match)
        await db.commit()

    except Exception as e:
        await db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

    return {
        "message": f"Đã giải trận. Kết quả kèo: {winning_choice}.",
        "adjusted_score": f"{adjusted_home} - {adjusted_away}",
        "winning_choice": winning_choice,
        "total_pool": total_pool,
        "refunded": refunded,
    }


async def _build_profile_payload(
    user: User,
    db: Optional[AsyncSession] = None,
    *,
    include_badge: bool = True,
) -> dict:
    payload = {
        "id": str(user.id),
        "email": user.email,
        "display_name": _user_display_name(user),
        "default_taunt": user.default_taunt,
        "total_points": user.total_points,
        "avatar_url": user.avatar_url,
        "avatar_color": user.avatar_color or "#6366f1",
        "initials": _user_initials(user),
        "is_admin": user.email.strip().lower() in ADMIN_EMAILS,
        "is_self": True,
        "can_edit": True,
    }
    if db is not None:
        payload["features"] = await _get_feature_settings(db)
        if include_badge:
            payload["badge"] = await _build_user_badge_for_profile(user, db)
    return payload


@app.post("/api/v1/bets", status_code=201)
async def place_bet_v2(
    payload: BetPayload,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _sync_match_statuses(db)

    match = (
        await db.execute(select(Match).where(Match.id == payload.match_id))
    ).scalars().first()
    if not match:
        raise HTTPException(status_code=404, detail="Trận đấu không tồn tại.")
    if match.status != MatchStatus.upcoming:
        raise HTTPException(status_code=400, detail="Trận này đã khóa đặt cược.")

    # Kèo chấp lẻ (0.5, 1.5, ...) không có kết quả hòa
    if payload.choice == "DRAW" and match.handicap % 1 != 0:
        raise HTTPException(status_code=400, detail="Kèo chấp lẻ không có cửa hòa.")

    min_stake = await _get_match_min_stake(db, payload.match_id)
    if min_stake is not None and payload.stake < min_stake:
        raise HTTPException(
            status_code=400,
            detail=f"Số điểm tối thiểu cho trận này là {_format_coins(min_stake)}.",
        )
    if user.total_points < payload.stake:
        raise HTTPException(status_code=400, detail="Số điểm không đủ.")

    taunt_text = _normalize_optional_taunt(payload.taunt_text)

    existing = (
        await db.execute(
            select(Bet).where(Bet.user_id == user.id, Bet.match_id == payload.match_id)
        )
    ).scalars().first()
    if existing:
        raise HTTPException(status_code=409, detail="Bạn đã đặt cược trận này rồi.")

    try:
        balance_update = await db.execute(
            update(User)
            .where(User.id == user.id, User.total_points >= payload.stake)
            .values(total_points=User.total_points - payload.stake)
            .execution_options(synchronize_session=False)
        )
        if balance_update.rowcount != 1:
            await db.rollback()
            raise HTTPException(status_code=400, detail="Số điểm không đủ.")

        bet = Bet(
            user_id=user.id,
            match_id=payload.match_id,
            choice=payload.choice,
            stake=payload.stake,
            taunt_text=taunt_text,
            points_earned=None,
        )
        db.add(bet)
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Bạn đã đặt cược trận này rồi.")
    except HTTPException:
        raise
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=500, detail=str(exc))

    await db.refresh(user)
    return {
        "message": "Đặt cược thành công.",
        "remaining_points": user.total_points,
        "min_stake": min_stake,
        "taunt_text": taunt_text,
    }


@app.get("/api/v1/matches/{match_id}/bets")
async def get_match_bets_v2(match_id: int, db: AsyncSession = Depends(get_db)):
    query = (
        select(Bet, User)
        .join(User, Bet.user_id == User.id)
        .where(Bet.match_id == match_id)
        .order_by(Bet.created_at.desc())
    )
    rows = (await db.execute(query)).all()

    result = {"HOME": [], "DRAW": [], "AWAY": []}
    choice_counts = {"HOME": 0, "DRAW": 0, "AWAY": 0}

    for row in rows:
        choice_counts[row.Bet.choice] = choice_counts.get(row.Bet.choice, 0) + 1

    for row in rows:
        my_count = choice_counts.get(row.Bet.choice, 0)
        other_max = max(v for k, v in choice_counts.items() if k != row.Bet.choice)
        is_lone_wolf = my_count == 1 and other_max >= 3
        result[row.Bet.choice].append(
            {
                **_user_avatar_payload(row.User),
                "stake": row.Bet.stake,
                "taunt_text": row.Bet.taunt_text,
                "created_at": row.Bet.created_at.isoformat() if row.Bet.created_at else None,
                "is_lone_wolf": is_lone_wolf,
            }
        )

    return result
