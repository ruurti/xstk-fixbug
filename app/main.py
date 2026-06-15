from fastapi import FastAPI, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from fastapi.requests import Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from datetime import datetime

from app.database import engine, Base, get_db
from app.models import Match, MatchStatus

app = FastAPI(title="Xác Suất & Thống Kê")

# Cấu hình nhúng file tĩnh và template HTML
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

@app.on_event("startup")
async def startup_event():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        
    # Tạo sẵn dữ liệu giả lập nếu DB trống để test giao diện
    async with AsyncSession(engine) as session:
        result = await session.execute(select(Match))
        if not result.scalars().first():
            mock_matches = [
                Match(home_team="Vietnam", away_team="Thailand", status=MatchStatus.upcoming, start_time=datetime(2026, 6, 20, 19, 0)),
                Match(home_team="Real Madrid", away_team="Barcelona", status=MatchStatus.upcoming, start_time=datetime(2026, 6, 21, 2, 45)),
                Match(home_team="Man City", away_team="Man United", status=MatchStatus.upcoming, start_time=datetime(2026, 6, 22, 22, 0))
            ]
            session.add_all(mock_matches)
            await session.commit()

# Route 1: Trả về giao diện trang chủ
@app.get("/", response_class=HTMLResponse)
async def read_home(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

# Route 2: API lấy danh sách trận đấu sắp diễn ra (upcoming)
@app.get("/api/v1/matches")
async def get_upcoming_matches(db: AsyncSession = Depends(get_db)):
    query = select(Match).where(Match.status == MatchStatus.upcoming).order_by(Match.start_time.asc())
    result = await db.execute(query)
    matches = result.scalars().all()
    return matches