import uuid
import enum
from datetime import datetime
from sqlalchemy import Column, String, Integer, Float, DateTime, ForeignKey, Enum, Uuid, UniqueConstraint
from .database import Base

class MatchStatus(str, enum.Enum):
    upcoming = "upcoming"
    live = "live"
    finished = "finished"

AVATAR_COLORS = [
    "#6366f1", "#8b5cf6", "#ec4899", "#f43f5e",
    "#f97316", "#eab308", "#22c55e", "#14b8a6",
    "#06b6d4", "#3b82f6", "#a855f7", "#84cc16",
]

import random as _random

def _random_avatar_color():
    return _random.choice(AVATAR_COLORS)

class User(Base):
    __tablename__ = "users"
    
    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(String, unique=True, nullable=False, index=True)
    display_name = Column(String, nullable=True)            # tên hiển thị tùy chỉnh
    total_points = Column(Integer, default=1000)
    avatar_url = Column(String, nullable=True)              # đường dẫn ảnh đã upload
    avatar_color = Column(String, nullable=True, default=_random_avatar_color)  # màu nền initials
    created_at = Column(DateTime, default=datetime.utcnow)

class Match(Base):
    __tablename__ = "matches"
    
    id = Column(Integer, primary_key=True, index=True)
    home_team = Column(String, nullable=False)
    home_icon = Column(String, nullable=True)
    away_team = Column(String, nullable=False)
    away_icon = Column(String, nullable=True)
    home_score = Column(Integer, default=0)
    away_score = Column(Integer, default=0)
    handicap = Column(Float, default=0.0)   # Kèo chấp: cộng vào điểm đội nhà
    status = Column(Enum(MatchStatus), default=MatchStatus.upcoming, nullable=False)
    start_time = Column(DateTime, nullable=False)
    resolved_at = Column(DateTime, nullable=True)

class Bet(Base):
    __tablename__ = "bets"
    __table_args__ = (
        UniqueConstraint("user_id", "match_id", name="uq_bets_user_match"),
    )
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    match_id = Column(Integer, ForeignKey("matches.id", ondelete="CASCADE"), nullable=False)
    choice = Column(String, nullable=False)        # 'HOME' | 'DRAW' | 'AWAY'
    stake = Column(Integer, nullable=False)        # Số điểm đặt cược
    points_earned = Column(Integer, nullable=True, default=None)
    created_at = Column(DateTime, default=datetime.utcnow)
