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
from pydantic import BaseModel, Field
from typing import Literal, Optional
import logging
import hashlib
import random
import uuid as uuid_lib
from pathlib import Path
import csv
import io
from decimal import Decimal, ROUND_DOWN

from app.database import engine, Base, get_db
from app.models import Match, MatchStatus, Bet, User
from app.dependencies import get_current_user, get_admin_user, ADMIN_EMAILS

logger = logging.getLogger(__name__)

app = FastAPI(title="Xác Suất & Thống Kê - Betting Engine")

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")
ASSET_VERSION = str(
    max(
        int(Path("static/css/style.css").stat().st_mtime),
        int(Path("static/js/app.js").stat().st_mtime),
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
            "resolved_at": "ALTER TABLE matches ADD COLUMN resolved_at DATETIME",
        }
        for column_name, ddl in missing_match_columns.items():
            if column_name not in match_column_names:
                await conn.exec_driver_sql(ddl)

        await conn.exec_driver_sql(
            """
            UPDATE matches
            SET resolved_at = start_time
            WHERE status = 'finished' AND resolved_at IS NULL
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
        result = await session.execute(select(Match))
        if not result.scalars().first():
            mock_matches = [
                Match(home_team="Vietnam", away_team="Thailand",
                      handicap=-0.5, status=MatchStatus.upcoming,
                      start_time=datetime(2026, 6, 20, 19, 0)),
                Match(home_team="Real Madrid", away_team="Barcelona",
                      handicap=-1.5, status=MatchStatus.upcoming,
                      start_time=datetime(2026, 6, 21, 2, 45)),
                Match(home_team="Man City", away_team="Man United",
                      handicap=0.5, status=MatchStatus.upcoming,
                      start_time=datetime(2026, 6, 22, 22, 0)),
            ]
            session.add_all(mock_matches)
            await session.commit()


# ─── Pydantic Schemas ─────────────────────────────────────────────────────────

class BetPayload(BaseModel):
    match_id: int
    choice: Literal["HOME", "DRAW", "AWAY"]
    stake: int = Field(..., ge=10)

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


# ─── Routes ──────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def read_home(request: Request):
    return templates.TemplateResponse(
        "index.html",
        {"request": request, "asset_version": ASSET_VERSION},
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
async def get_me(user: User = Depends(get_current_user)):
    base_name = user.email.split("@")[0]
    display_name = user.display_name or base_name
    initials = (display_name[:2]).upper()
    is_admin = user.email.strip().lower() in ADMIN_EMAILS
    return {
        "email": user.email,
        "display_name": display_name,
        "total_points": user.total_points,
        "avatar_url": user.avatar_url,
        "avatar_color": user.avatar_color or "#6366f1",
        "initials": initials,
        "is_admin": is_admin,
    }


# POST /api/v1/me/update — Cập nhật thông tin cá nhân (display_name)
# Dùng POST thay vì PATCH vì Cloudflare Access Gateway chặn PATCH/PUT/DELETE
class UpdateProfilePayload(BaseModel):
    display_name: Optional[str] = None

@app.post("/api/v1/me/update")
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


# GET /api/v1/matches — Danh sách upcoming kèm pool stats per match
@app.get("/api/v1/matches")
async def get_upcoming_matches(db: AsyncSession = Depends(get_db)):
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

    query = (
        select(
            Match,
            func.coalesce(pool_q.c.stakes_home, 0).label("stakes_home"),
            func.coalesce(pool_q.c.stakes_draw, 0).label("stakes_draw"),
            func.coalesce(pool_q.c.stakes_away, 0).label("stakes_away"),
            func.coalesce(pool_q.c.total_pool, 0).label("total_pool"),
        )
        .outerjoin(pool_q, Match.id == pool_q.c.match_id)
        .where(Match.status == MatchStatus.upcoming)
        .order_by(Match.start_time.asc())
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
            "stakes_home": r.stakes_home,
            "stakes_draw": r.stakes_draw,
            "stakes_away": r.stakes_away,
            "total_pool": r.total_pool,
        }
        for r in rows
    ]


# POST /api/v1/bets — Đặt cược (Transaction)
@app.post("/api/v1/bets", status_code=201)
async def place_bet(
    payload: BetPayload,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Validate match
    match = (await db.execute(
        select(Match).where(Match.id == payload.match_id)
    )).scalars().first()

    if not match:
        raise HTTPException(status_code=404, detail="Trận đấu không tồn tại.")
    if match.status != MatchStatus.upcoming:
        raise HTTPException(status_code=400, detail="Trận đấu không còn nhận cược.")

    # Validate balance
    if user.total_points < payload.stake:
        raise HTTPException(status_code=400, detail="Số điểm không đủ.")

    # Kiểm tra đã cược chưa (1 user / 1 match)
    existing = (await db.execute(
        select(Bet).where(Bet.user_id == user.id, Bet.match_id == payload.match_id)
    )).scalars().first()
    if existing:
        raise HTTPException(status_code=409, detail="Bạn đã đặt cược cho trận này.")

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
        raise HTTPException(status_code=409, detail="Bạn đã đặt cược cho trận này.")
    except HTTPException:
        raise
    except Exception as e:
        await db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

    await db.refresh(user)
    return {"message": "Đặt cược thành công.", "remaining_points": user.total_points}


# ─── GET /api/v1/matches/{match_id}/bets — Avatar Stack ──────────────────────
@app.get("/api/v1/matches/{match_id}/bets")
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
            "name": name,
            "initials": initials,
            "stake": r.Bet.stake,
            "is_lone_wolf": is_lone_wolf,
        }
        result[r.Bet.choice].append(entry)

    return result


# ─── GET /api/v1/matches/{match_id}/detail — Chi tiết trận và đặt cược ───────
@app.get("/api/v1/matches/{match_id}/detail")
async def get_match_detail(
    match_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
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
    match = (
        await db.execute(
            select(Match)
            .where(Match.status == MatchStatus.finished)
            .order_by(desc(func.coalesce(Match.resolved_at, Match.start_time)), desc(Match.id))
            .limit(1)
        )
    ).scalars().first()
    if not match:
        raise HTTPException(status_code=404, detail="Chưa có trận nào hoàn tất.")

    return await _build_match_detail_payload(match=match, user=user, db=db)


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
            "rank": rank,
            "name": _user_display_name(user),
            "total_points": user.total_points,
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
        "🔥 {name} vừa tất tay {stake} điểm vào {team}",
        "💸 {name} đặt {stake} điểm chọn {team}",
        "🎯 {name} tin tưởng {team} với {stake} điểm",
        "🤡 {name} lại tiếp tục tin tưởng {team}",
        "😤 {name} quyết tâm với {team} — {stake} điểm",
        "🃏 {name} bài ngửa {stake} điểm vào {team}",
        "💰 {name} cược đậm {stake} điểm vào {team}",
        "💪 {name} vô {stake} điểm vào {team}, liệu có nhổ được xe?",
        "👍 {name} xuống xác {stake} điểm vào {team}"
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
        text = tpl.format(name=name, stake=r.Bet.stake, team=team)
        activities.append({
            "text": text,
            "time": r.Bet.created_at.isoformat(),
        })

    return activities


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
        "resolved_at": match.resolved_at.isoformat() if getattr(match, "resolved_at", None) else None,
    }


def _choice_label(choice: Optional[str]) -> str:
    return CHOICE_LABELS.get(choice or "", choice or "Không rõ")


def _user_display_name(user: User) -> str:
    return user.display_name or user.email.split("@")[0]


def _user_initials(user: User) -> str:
    return _user_display_name(user)[:2].upper()


def _stable_pick(options, seed: str) -> str:
    if not options:
        return ""
    digest = hashlib.md5(seed.encode("utf-8")).hexdigest()
    return options[int(digest, 16) % len(options)]


def _format_reward_label(outcome: str, stake: int, points_earned: Optional[int]) -> str:
    if outcome == "WIN":
        return f"+{int(points_earned or 0):,}đ"
    if outcome == "LOSE":
        return "0đ"
    if outcome == "REFUND":
        return f"Hoàn {int(stake):,}đ"
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
    return template.format(name=name, choice=choice_text, winner=winner_text, stake=stake)


def _build_headline_quote(
    *,
    match: Match,
    settlement: dict,
    summary: dict,
) -> str:
    if settlement["is_finished"]:
        if settlement["refunded"]:
            return _stable_pick(
                [
                    "Kèo này hoàn điểm, nên ai cũng rời bàn với vẻ mặt khá lịch sự.",
                    "Trận đã xong nhưng không cửa nào đủ lực để giữ lại màn khịa dài lâu.",
                    "Không ai ăn đủ, thế là cuộc vui tạm dừng trong thế cân bằng hơi buồn cười.",
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
    adjusted_home = match.home_score + match.handicap
    adjusted_away = match.away_score
    if adjusted_home > adjusted_away:
        winning_choice = "HOME"
    elif adjusted_home < adjusted_away:
        winning_choice = "AWAY"
    else:
        winning_choice = "DRAW"

    total_pool = sum(summary[ch]["stake"] for ch in summary)
    stakes_on_winner = summary[winning_choice]["stake"]
    has_bets = bool(rows)
    refunded = is_finished and has_bets and (stakes_on_winner == 0)

    settlement = {
        "is_finished": is_finished,
        "winning_choice": winning_choice if is_finished else None,
        "winning_choice_label": _choice_label(winning_choice) if is_finished else None,
        "adjusted_home_score": adjusted_home if is_finished else None,
        "adjusted_away_score": adjusted_away if is_finished else None,
        "adjusted_score": f"{adjusted_home}-{adjusted_away}" if is_finished else None,
        "score": f"{match.home_score}-{match.away_score}" if is_finished else None,
        "refunded": refunded,
        "winner_count": 0,
        "loser_count": 0,
        "refund_count": 0,
        "headline_quote": None,
    }

    for row in rows:
        if not is_finished:
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

        name = _user_display_name(row.User)
        initials = _user_initials(row.User)
        bettors[row.Bet.choice].append({
            "name": name,
            "initials": initials,
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
                winning_choice=winning_choice if is_finished else None,
                name=name,
            ),
            "reward_label": _format_reward_label(outcome, row.Bet.stake, row.Bet.points_earned),
            "points_earned": row.Bet.points_earned,
        })

    my_row = next((row for row in rows if row.User.id == user.id), None)
    my_bet = None
    if my_row:
        if not is_finished:
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
                winning_choice=winning_choice if is_finished else None,
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
    query = select(Match).order_by(Match.start_time.asc())
    rows = (await db.execute(query)).scalars().all()
    return [_match_response(r) for r in rows]


# POST /api/v1/admin/matches — Thêm trận đấu mới
@app.post("/api/v1/admin/matches", status_code=201)
async def create_match(
    payload: MatchPayload,
    admin_user: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    if payload.status == MatchStatus.finished:
        raise HTTPException(status_code=400, detail="Hãy dùng chức năng giải trận để kết thúc trận.")

    try:
        match = Match(
            home_team=payload.home_team.strip(),
            home_icon=(payload.home_icon or "").strip() or None,
            away_team=payload.away_team.strip(),
            away_icon=(payload.away_icon or "").strip() or None,
            handicap=payload.handicap,
            status=payload.status,
            start_time=payload.start_time,
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

    try:
        match.home_team = payload.home_team.strip()
        match.home_icon = (payload.home_icon or "").strip() or None
        match.away_team = payload.away_team.strip()
        match.away_icon = (payload.away_icon or "").strip() or None
        match.handicap = payload.handicap
        match.status = payload.status
        match.start_time = payload.start_time
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
    match = (await db.execute(
        select(Match).where(Match.id == match_id)
    )).scalars().first()

    if not match:
        raise HTTPException(status_code=404, detail="Trận đấu không tồn tại.")
    if match.status == MatchStatus.finished:
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
        match.resolved_at = datetime.utcnow()
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
