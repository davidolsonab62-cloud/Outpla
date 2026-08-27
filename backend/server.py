from fastapi import FastAPI, APIRouter, HTTPException, Depends, Request, Response, Path as FastAPIPath
from fastapi.responses import JSONResponse, RedirectResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import os
import re
import io
import hashlib
import shutil
import logging
from pathlib import Path
from urllib.parse import urlencode, parse_qs
from pydantic import BaseModel, Field, ConfigDict, EmailStr
from typing import List, Optional, Dict, Any
import uuid
from datetime import datetime, timezone, timedelta
import requests
from passlib.context import CryptContext
from jose import JWTError, jwt
import socketio
import random
import statistics
import asyncio
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# Try to import stockfish, but do not require it for server startup
try:
    from stockfish import Stockfish
except ImportError:
    Stockfish = None

# Try to import cryptography for at-rest encryption of stream OAuth tokens
try:
    from cryptography.fernet import Fernet, InvalidToken
except ImportError:
    Fernet = None
    InvalidToken = Exception

# Configure logging early so it is available during module import
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def resolve_stockfish_path() -> Optional[str]:
    """Resolve a local Stockfish binary path on Windows and Unix."""
    candidates = []
    env_path = os.environ.get('STOCKFISH_PATH')
    if env_path:
        candidates.append(env_path)

    candidates.extend([shutil.which('stockfish'), shutil.which('stockfish.exe')])

    if os.name == 'nt':
        candidates.extend([
            r"C:\Program Files\Stockfish\stockfish.exe",
            r"C:\Program Files (x86)\Stockfish\stockfish.exe",
            r"C:\Stockfish\stockfish.exe",
            str(Path.home() / 'AppData' / 'Local' / 'Programs' / 'Stockfish' / 'stockfish.exe'),
            str(Path.home() / 'AppData' / 'Local' / 'Stockfish' / 'stockfish.exe'),
        ])
    else:
        candidates.extend([
            '/usr/games/stockfish',
            '/usr/bin/stockfish',
            '/snap/bin/stockfish'
        ])

    # Allow a relative path in the project root if the engine is bundled locally
    candidates.append(str(ROOT_DIR / 'stockfish'))
    candidates.append(str(ROOT_DIR / 'stockfish.exe'))

    # Log all candidates being checked for debugging
    print(f"[Stockfish Resolution] Checking {len(candidates)} candidate paths...")
    for i, candidate in enumerate(candidates, 1):
        if candidate:
            exists = os.path.exists(candidate)
            status = "[OK]" if exists else "[--]"
            print(f"  [{i}] {candidate}: {status}")
            if exists:
                print(f"[Stockfish Resolution] Selected: {candidate}")
                return candidate
        else:
            print(f"  [{i}] (None/empty)")
    
    print(f"[Stockfish Resolution] No valid Stockfish binary found in any candidate path")
    return None

STOCKFISH_PATH = resolve_stockfish_path()
STOCKFISH_AVAILABLE = bool(STOCKFISH_PATH and os.path.exists(STOCKFISH_PATH))

logger.info(f"Resolved STOCKFISH_PATH={STOCKFISH_PATH}, STOCKFISH_AVAILABLE={STOCKFISH_AVAILABLE}")

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# JWT Configuration
SECRET_KEY = os.environ.get('JWT_SECRET', 'stakechess-secret-key-change-in-production')
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_HOURS = 24

# Encryption for stream OAuth tokens at rest (access_token / refresh_token in
# db.stream_accounts). Generate a key once with:
#   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
# and set it as STREAM_TOKEN_ENCRYPTION_KEY in the environment - never commit it.
STREAM_TOKEN_ENCRYPTION_KEY = os.environ.get('STREAM_TOKEN_ENCRYPTION_KEY')
_stream_cipher = None
if Fernet and STREAM_TOKEN_ENCRYPTION_KEY:
    try:
        _stream_cipher = Fernet(STREAM_TOKEN_ENCRYPTION_KEY.encode())
    except (ValueError, TypeError) as e:
        logger.error(f"Invalid STREAM_TOKEN_ENCRYPTION_KEY, stream tokens will NOT be encrypted: {e}")
elif Fernet and not STREAM_TOKEN_ENCRYPTION_KEY:
    logger.warning("STREAM_TOKEN_ENCRYPTION_KEY not set - stream OAuth tokens will be stored in plaintext")
else:
    logger.warning("cryptography package not installed - stream OAuth tokens will be stored in plaintext")


def encrypt_stream_token(value: Optional[str]) -> Optional[str]:
    """Encrypts a stream OAuth token for storage. Passes the value through
    unchanged (with a one-time warning already logged above) if no cipher is
    configured, so the feature still works in dev without a key set."""
    if value is None:
        return None
    if not _stream_cipher:
        return value
    return _stream_cipher.encrypt(value.encode()).decode()


def decrypt_stream_token(value: Optional[str]) -> Optional[str]:
    """Reverses encrypt_stream_token. Returns None (rather than raising) if
    the value can't be decrypted, so a stale/corrupt token just looks
    disconnected instead of crashing the request."""
    if value is None:
        return None
    if not _stream_cipher:
        return value
    try:
        return _stream_cipher.decrypt(value.encode()).decode()
    except InvalidToken:
        logger.error("Failed to decrypt a stream OAuth token - it may predate the current encryption key")
        return None

# Password hashing
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# Parse CORS origins for both Socket.IO and FastAPI middleware
cors_origins_raw = os.environ.get('CORS_ORIGINS', 'http://localhost:3000,http://localhost:3001,http://localhost:3002,http://localhost:3006')
cors_origins_list = [origin.strip() for origin in cors_origins_raw.split(',') if origin.strip()]
# Ensure the local development port is always allowed
if 'http://localhost:3006' not in cors_origins_list:
    cors_origins_list.append('http://localhost:3006')
for port in ['3000', '3001', '3002', '3006']:
    local_origin = f'http://127.0.0.1:{port}'
    if local_origin not in cors_origins_list:
        cors_origins_list.append(local_origin)
if not cors_origins_list:
    cors_origins_list = ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3006']

# Allow the local dev machine to use either localhost or 127.0.0.1 on the common ports.
allow_origin_regex = r"^https?://(localhost|127\.0\.0\.1):(3000|3001|3002|3006)$"

# Socket.IO server - configured for proxy/kubernetes environment
sio = socketio.AsyncServer(
    async_mode='asgi',
    # Let FastAPI's CORSMiddleware handle CORS headers to avoid duplicate Access-Control-Allow-Origin
    cors_allowed_origins=[],
    logger=True,
    engineio_logger=True,
    ping_timeout=60,
    ping_interval=25,
    max_http_buffer_size=1e6,
    # Allow both transports for compatibility
    transports=['polling', 'websocket']
)

# Create the main app
app = FastAPI(title="StakeChess API")

# NOTE: CORS is intentionally NOT added here. This FastAPI app gets wrapped
# by socketio.ASGIApp and then by CORSMiddleware at the very bottom of this
# file - that outer layer is the one that actually applies to every request
# (both Socket.IO and REST). Adding it here too used to double up the
# Access-Control-Allow-Origin header, which browsers treat as invalid and
# reject outright - producing a "No Access-Control-Allow-Origin header"
# CORS error in devtools even when the origin was correctly allow-listed.

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)
logger.info(f"Parsed CORS origins: {cors_origins_list}")

# Initialize scheduler for automated tournaments
scheduler = AsyncIOScheduler()

# Stockfish engine instance (lazy loaded)
stockfish_engine = None

def get_stockfish():
    """Get or create Stockfish engine instance"""
    global stockfish_engine
    if STOCKFISH_AVAILABLE and stockfish_engine is None:
        try:
            stockfish_engine = Stockfish(
                path=STOCKFISH_PATH,
                depth=15,
                parameters={"Threads": 1, "Hash": 64}
            )
            logger.info("Stockfish engine initialized")
        except Exception as e:
            logger.error(f"Failed to initialize Stockfish: {e}")
            return None
    return stockfish_engine

# ============= MODELS =============

# Keep in sync with BOARD_THEME_STYLES / BOARD_COLOR_PALETTES in Game.jsx
# and the <select> options in Profile.jsx.
VALID_BOARD_THEMES = {"classic", "wood", "glass", "modern"}
VALID_BOARD_COLORS = {"default", "blue", "green", "purple", "brown"}

def _validate_board_preferences(board_preferences: Dict[str, Any]) -> Dict[str, Any]:
    """Validate and sanitize a board_preferences dict, dropping unknown keys
    and rejecting unrecognized theme/color values so bad data can't get
    persisted and silently fall back client-side."""
    theme = board_preferences.get("theme")
    color = board_preferences.get("color")
    if theme is not None and theme not in VALID_BOARD_THEMES:
        raise HTTPException(status_code=400, detail=f"Invalid board theme: {theme}")
    if color is not None and color not in VALID_BOARD_COLORS:
        raise HTTPException(status_code=400, detail=f"Invalid board color: {color}")
    cleaned = {}
    if theme is not None:
        cleaned["theme"] = theme
    if color is not None:
        cleaned["color"] = color
    return cleaned

class UserCreate(BaseModel):
    name: str
    email: EmailStr
    password: str

class UserLogin(BaseModel):
    email: EmailStr
    password: str

class UserResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")
    user_id: str
    username: str
    email: str
    picture: Optional[str] = None
    rating: int = 1200
    games_played: int = 0
    wins: int = 0
    fide_id: Optional[str] = None
    country: Optional[str] = None
    team_club: Optional[str] = None
    chess_title: Optional[str] = None
    chess_bio: Optional[str] = None
    board_preferences: Optional[Dict[str, Any]] = None
    challenge_preferences: Optional[Dict[str, Any]] = None
    losses: int = 0
    draws: int = 0
    wallet_balance: Dict[str, float] = Field(default_factory=lambda: {"USDT": 0, "BTC": 0, "ETH": 0})
    credits_balance: int = 0
    allow_spectators: bool = True
    allow_chat_broadcast: bool = True
    # IANA timezone name (e.g. "America/New_York"), used to localize
    # daily-reset features like Phase 4b's puzzle retry/skip budgets.
    # None means "not set yet" - callers fall back to UTC.
    timezone: Optional[str] = None
    created_at: Optional[str] = None
    is_admin: bool = False
    is_flagged: bool = False
    is_banned: bool = False

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse

class GameCreate(BaseModel):
    time_control: str = "10+0"
    stake_amount: float = 0
    stake_currency: str = "USDT"
    is_private: bool = False
    game_type: str = "rapid"
    tournament_id: Optional[str] = None

class GameResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")
    game_id: str
    white_player: Optional[Dict] = None
    black_player: Optional[Dict] = None
    time_control: str
    stake_amount: float
    stake_currency: str
    arbiter_fee: float = 0.02
    status: str = "waiting"
    fen: str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    moves: List[str] = []
    move_times: List[float] = []
    white_time: int = 600
    black_time: int = 600
    current_turn: str = "white"
    result: Optional[str] = None
    winner_id: Optional[str] = None
    reconnect_deadline: Optional[str] = None
    created_at: str
    is_private: bool = False
    game_type: str = "rapid"
    tournament_id: Optional[str] = None
    # Phase 4c: boosted lobby visibility ("featured game"). Defaulted so
    # existing game docs without these fields still validate.
    featured: bool = False
    featured_until: Optional[str] = None

class MatchmakingRequest(BaseModel):
    time_control: str = "10+0"
    game_type: str = "rapid"

class MoveRequest(BaseModel):
    game_id: str
    move: str
    fen: str
    move_time: Optional[float] = None
    white_time: Optional[int] = None
    black_time: Optional[int] = None

STREAM_PLATFORMS = ("tiktok", "instagram", "facebook", "youtube")

class StreamAccountResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")
    platform: str
    connected: bool = False
    username: Optional[str] = None
    connected_at: Optional[str] = None

class StreamConnectRequest(BaseModel):
    # Where to send the user's browser back to in the SPA once the OAuth
    # dance finishes (e.g. window.location.href). This is NOT the OAuth
    # redirect_uri - that's computed server-side, see _stream_oauth_redirect_uri.
    frontend_redirect: Optional[str] = None

class StreamGoLiveRequest(BaseModel):
    game_id: Optional[str] = None

class StreamYoutubeCodeRequest(BaseModel):
    # The one-time authorization code handed to the frontend's JS callback
    # by the Google Identity Services popup (google.accounts.oauth2
    # .initCodeClient with ux_mode: 'popup'). See connect_youtube_via_code.
    code: str

class WalletTransaction(BaseModel):
    model_config = ConfigDict(extra="ignore")
    tx_id: str
    user_id: str
    tx_type: str
    amount: float
    currency: str
    status: str = "completed"
    created_at: str
    related_game_id: Optional[str] = None

class DepositRequest(BaseModel):
    amount: float
    currency: str

class WithdrawRequest(BaseModel):
    amount: float
    currency: str
    wallet_address: str
    withdrawal_method: str = "crypto"  # crypto, bank_transfer, etc.

class WithdrawStatusUpdate(BaseModel):
    status: str  # confirmed, rejected
    admin_note: Optional[str] = None

class CreditTransactionResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")
    tx_id: str
    user_id: str
    amount: int
    type: str
    reference_id: Optional[str] = None
    resulting_balance: int
    created_at: str

class BuyCreditsRequest(BaseModel):
    amount_usdt: float

class SpendCreditsRequest(BaseModel):
    feature_key: str
    reference_id: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None

class CreditFeatureCostUpdate(BaseModel):
    cost: int
    category: Optional[str] = None

class PGNAnalyzeRequest(BaseModel):
    pgn: str

class PGNImportRequest(BaseModel):
    # Optional client-supplied identifier for the imported PGN (e.g. a hash
    # of its contents) so the ledger/reference_id for a paid import can be
    # traced back to a specific game; not required to record the import.
    reference_id: Optional[str] = None

class ClockPresetCreate(BaseModel):
    # Phase 4e: a user-saved custom time control for the standalone Chess
    # Clock tool (/chess-clock), beyond the small set of built-in defaults
    # the frontend already offers (1+0, 3+0, 5+0, 10+0, 15+10).
    name: str
    white_minutes: float
    black_minutes: float
    increment_seconds: int = 0

class ClockPresetResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")
    preset_id: str
    name: str
    white_minutes: float
    black_minutes: float
    increment_seconds: int = 0
    created_at: str

class AdminSettingsUpdate(BaseModel):
    arbiter_fee: Optional[float] = None
    min_stake: Optional[float] = None
    max_stake: Optional[float] = None
    puzzle_base_reward: Optional[int] = None
    puzzle_reward_scale: Optional[float] = None
    puzzle_difficulty_count: Optional[int] = None

class PuzzleResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")
    puzzle_id: str
    # Identifies this particular solving session (see /puzzles/next). Moves
    # are submitted against the attempt, not the puzzle_id, so the server
    # can track how far through the multi-move solution the player has
    # progressed without trusting anything the client claims about that.
    attempt_id: str
    title: str
    description: str
    fen: str
    difficulty: int
    reward: int
    objective: str
    side_to_move: str
    hints: List[str]
    coaching: str
    created_at: str

class PuzzleMoveRequest(BaseModel):
    # A single SAN move (e.g. "Nxf6") - one ply per request, not the whole
    # solution. The frontend submits this every time the player drops a
    # piece; the server checks it against the next expected ply only.
    move: str

class PuzzleProgressResponse(BaseModel):
    solved_count: int
    earned_rating: int
    current_difficulty: int
    recent_solved: List[Dict] = Field(default_factory=list)

class TournamentCreate(BaseModel):
    name: str
    time_control: str = "3+2"
    entry_fee: float = 5.0
    entry_currency: str = "USDT"
    min_players: int = 4
    max_players: int = 64
    tournament_type: str = "arena"
    start_time: Optional[str] = None
    duration_minutes: int = 60

# Phase 4c: user-facing (non-admin) tournament creation. Deliberately a
# separate, smaller model from TournamentCreate rather than reusing it -
# no start_time (always starts shortly after creation, same as an unset
# admin start_time) and tighter default caps appropriate for a private
# group instead of a public arena event.
class PrivateTournamentCreate(BaseModel):
    name: str
    time_control: str = "3+2"
    entry_fee: float = 0
    entry_currency: str = "USDT"
    min_players: int = 2
    max_players: int = 16
    tournament_type: str = "arena"
    duration_minutes: int = 60

class JoinTournamentRequest(BaseModel):
    invite_code: Optional[str] = None

class TournamentResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")
    tournament_id: str
    name: str
    time_control: str
    entry_fee: float
    entry_currency: str
    prize_pool: float = 0
    min_players: int
    max_players: int
    current_players: int = 0
    tournament_type: str
    status: str = "upcoming"
    start_time: str
    end_time: Optional[str] = None
    duration_minutes: int
    created_at: str
    players: List[Dict] = []
    leaderboard: List[Dict] = []
    pairings: List[Dict] = Field(default_factory=list)
    # Phase 4c: private/custom tournaments. Defaulted so older (admin,
    # public) tournament docs without these fields still validate fine -
    # they just read as is_private=False, invite_code=None.
    is_private: bool = False
    invite_code: Optional[str] = None
    created_by: Optional[str] = None

# ============= HELPER FUNCTIONS =============

def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)

def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)

def generate_tournament_pairings(players: List[Dict]) -> List[Dict]:
    """Generate simple rating-based tournament pairings."""
    if not players:
        return []

    # Shuffle first so that players with equal (e.g. default) ratings don't
    # always sort in join order — Python's sort is stable, so without this,
    # ties break by join order every time, and whoever joined last always
    # ends up at the bottom of the sort and gets the bye on odd counts.
    shuffled = players.copy()
    random.shuffle(shuffled)
    sorted_players = sorted(shuffled, key=lambda p: p.get("rating", 1200), reverse=True)
    pairings = []

    # For odd player count, create a bye for the lowest-rated player
    if len(sorted_players) % 2 != 0:
        bye_player = sorted_players.pop()
        pairings.append({
            "player_white": bye_player,
            "player_black": None,
            "note": "bye"
        })

    for i in range(0, len(sorted_players), 2):
        player_a = sorted_players[i]
        player_b = sorted_players[i + 1]
        pairings.append({
            "player_white": player_a,
            "player_black": player_b,
            "rating_difference": abs(player_a.get("rating", 1200) - player_b.get("rating", 1200))
        })

    return pairings


def create_access_token(data: dict) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

async def get_watchable_match_count() -> int:
    query = {
        "status": "active",
        "is_private": False,
        "white_player.allow_spectators": True,
        "black_player.allow_spectators": True,
    }
    count = await db.games.count_documents(query)
    return count

async def emit_watchable_count_update():
    count = await get_watchable_match_count()
    await sio.emit("watchable_count_update", {"count": count})

async def build_puzzle_doc(index: int, settings: dict) -> dict:
    difficulty = min(settings.get("puzzle_difficulty_count", 10), max(1, int(index / (10000 / settings.get("puzzle_difficulty_count", 10))) + 1))
    # Each position below is a genuine tactic (a fork, a hanging piece, a
    # skewer-like double attack). "solution" is now a full ordered list of
    # SAN plies, not a single move: some puzzles resolve in one move (a
    # hanging piece - there is nothing to continue), others are real
    # multi-move sequences where ply 0 is the player's move, ply 1 is the
    # opponent's reply (auto-played by the server - see /puzzles/next and
    # /puzzles/attempts/{id}/move), and ply 2 is the player finishing the
    # combination. Every fen/solution pair has been hand-verified move by
    # move for legality (piece paths, knight-move geometry, check status,
    # and that captured pieces are actually undefended after each ply) so
    # the board never just looks like an ordinary, "arranged" position
    # with nothing to find, and the scripted opponent replies never
    # accidentally save the material or block the follow-up.
    base_puzzles = [
        {
            "fen": "7k/8/5q2/3N4/8/8/8/7K w - - 0 1",
            "solution": ["Nxf6"],
            "objective": "Capture the undefended queen with your knight - a huge material gain.",
            "hints": ["The black queen has no protection.", "Your knight can jump right into it."],
            "coaching": "Always check whether the opponent's most valuable piece is defended.",
        },
        {
            "fen": "6k1/8/8/3b4/8/8/8/3R2K1 w - - 0 1",
            "solution": ["Rxd5"],
            "objective": "Capture the undefended bishop and win material.",
            "hints": ["The bishop on d5 has no defender.", "Your rook already commands the open d-file."],
            "coaching": "Always scan for undefended pieces before making a plan.",
        },
        {
            "fen": "7k/8/8/1n6/P7/8/8/7K w - - 0 1",
            "solution": ["axb5"],
            "objective": "Grab the hanging knight with a simple pawn capture.",
            "hints": ["Look at what your a-pawn can capture.", "The knight on b5 is undefended."],
            "coaching": "Don't overlook small pawn captures - they can win material for free.",
        },
        {
            "fen": "k7/8/8/7n/8/8/8/K6R w - - 0 1",
            "solution": ["Rxh5"],
            "objective": "Snap off the hanging knight with your rook.",
            "hints": ["The knight on h5 is undefended.", "Your rook already controls the h-file."],
            "coaching": "Open files are highways for your rooks to grab loose material.",
        },
        {
            "fen": "k7/6r1/8/8/8/8/1B6/K7 w - - 0 1",
            "solution": ["Bxg7"],
            "objective": "Snipe the hanging rook along the long diagonal.",
            "hints": ["Your bishop's diagonal runs straight to g7.", "The black rook has no defender."],
            "coaching": "Long diagonals are powerful highways for bishops to win material.",
        },
        {
            # 1.Nb6 forks Ra8/Bc8. 1...Ra5 (scripted try - saving the rook,
            # off the a8 square) 2.Nxc8 wins the bishop; Ra5 defends
            # neither c8 nor gives check, so the win is clean.
            "fen": "r1b1k3/8/8/3N4/8/8/8/6K1 w - - 0 1",
            "solution": ["Nb6", "Ra5", "Nxc8"],
            "objective": "Fork the rook and bishop with your knight, then follow up to win material.",
            "hints": ["One knight move attacks two pieces at once.", "Whichever piece black saves, the other one falls next."],
            "coaching": "Knight forks are strongest when neither target square is defended - keep playing the combination out, don't stop at the first move.",
        },
        {
            # 1.Qd5 attacks Na5/Be5. 1...Nb7 (scripted try - retreating the
            # knight to a square that does NOT defend e5) 2.Qxe5+ wins the
            # bishop with check along the long diagonal.
            "fen": "7k/8/8/n3b3/8/8/K7/3Q4 w - - 0 1",
            "solution": ["Qd5", "Nb7", "Qxe5+"],
            "objective": "Move your queen to attack both the knight and bishop at once, then win one of them.",
            "hints": ["Look along the fifth rank.", "Both black minor pieces are undefended - saving one loses the other."],
            "coaching": "Centralizing your queen can create multiple threats simultaneously - follow the combination through to actually winning the piece.",
        },
        {
            # 1.Bc5 forks Ra7/Rf8. 1...Rd7 (scripted try - saving the a7
            # rook off both diagonals) 2.Bxf8 wins the other rook; Rd7
            # doesn't defend f8.
            "fen": "5r1k/r7/8/8/8/8/8/1K4B1 w - - 0 1",
            "solution": ["Bc5", "Rd7", "Bxf8"],
            "objective": "Fork both black rooks with a single bishop move, then capture the one that isn't saved.",
            "hints": ["Look for a square where your bishop covers two diagonals at once.", "Both rooks are undefended - black can only save one."],
            "coaching": "A well-placed bishop can attack two targets along different diagonals - keep playing until you've actually banked the material.",
        },
        {
            "fen": "7k/3b4/8/R7/8/3n4/8/K7 w - - 0 1",
            "solution": ["Rd5"],
            "objective": "Centralize your rook to fork the bishop and knight on the d-file.",
            "hints": ["Look at the d-file - two black pieces sit on it.", "A rook lift to d5 attacks both at once."],
            "coaching": "Open files let a single rook threaten multiple targets.",
        },
        {
            # 1.Nc7+ forks Ke8/Qa8 with check. 1...Kd8 (scripted legal
            # reply - the only other square, d7, is also fine but Kd8
            # keeps the line simple; neither defends a8) 2.Nxa8 wins the
            # queen regardless of which legal square the king chose.
            "fen": "q3k3/8/8/3N4/8/8/8/6K1 w - - 0 1",
            "solution": ["Nc7+", "Kd8", "Nxa8"],
            "objective": "Fork the king and queen with a knight jump, then cash in the queen.",
            "hints": ["The knight can jump to c7.", "From c7 the knight hits both the king and the queen - the check comes first, the queen falls next."],
            "coaching": "The classic knight fork is one of the most common tactical weapons - always scan for it, and remember to actually take the piece once the king moves.",
        },
    ]
    puzzle = base_puzzles[index % len(base_puzzles)]
    turn = puzzle["fen"].split()[1]
    side_to_move = "White" if turn == "w" else "Black"
    return {
        "puzzle_id": f"puzzle_{index + 1}",
        "title": f"Puzzle #{index + 1} - {difficulty}-Star Tactic",
        "description": f"{puzzle['objective']} {puzzle['coaching']}",
        "fen": puzzle["fen"],
        "difficulty": difficulty,
        "reward": settings.get("puzzle_base_reward", 15) + (difficulty - 1) * int(settings.get("puzzle_reward_scale", 3)),
        "objective": puzzle["objective"],
        "side_to_move": side_to_move,
        "hints": puzzle["hints"],
        "coaching": puzzle["coaching"],
        "solution": puzzle["solution"],
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

async def normalize_puzzle_doc(doc: dict, settings: dict) -> dict:
    puzzle = dict(doc)

    if _puzzle_doc_is_broken(puzzle):
        # Runtime safety net: even if the startup/admin repair pass hasn't
        # run yet (or missed this doc for some reason), never hand back an
        # unsolvable placeholder. Regenerate it from the real template list
        # right here, keep its identity/difficulty stable, and persist the
        # fix so solve_puzzle - which reads the raw doc directly rather
        # than going through this function - checks against the same
        # solution the player was actually shown.
        try:
            index = int(str(puzzle.get("puzzle_id", "")).rsplit("_", 1)[-1]) - 1
        except (ValueError, IndexError):
            index = random.randrange(10000)
        fresh = await build_puzzle_doc(index, settings)
        fresh["puzzle_id"] = puzzle.get("puzzle_id") or fresh["puzzle_id"]
        if puzzle.get("difficulty") is not None:
            fresh["difficulty"] = puzzle["difficulty"]
        if puzzle.get("puzzle_id"):
            await db.puzzles.update_one({"puzzle_id": puzzle["puzzle_id"]}, {"$set": fresh}, upsert=True)
        puzzle = fresh

    if not puzzle.get("objective"):
        puzzle["objective"] = "Solve this tactical position and find the best move."
    if not puzzle.get("side_to_move"):
        fen_parts = puzzle.get("fen", "").split()
        turn = fen_parts[1] if len(fen_parts) > 1 else "w"
        puzzle["side_to_move"] = "White" if turn == "w" else "Black"
    if puzzle.get("hints") is None:
        puzzle["hints"] = []
    if puzzle.get("coaching") is None:
        puzzle["coaching"] = ""
    if not puzzle.get("title"):
        puzzle["title"] = f"Puzzle {puzzle.get('puzzle_id', 'unknown')}"
    if not puzzle.get("description"):
        puzzle["description"] = puzzle["objective"]
    if not puzzle.get("created_at"):
        puzzle["created_at"] = datetime.now(timezone.utc).isoformat()
    if not puzzle.get("fen"):
        # A real, valid FEN - not the string "start", which chess.js can't
        # parse and silently ignores, leaving its own default starting
        # position on screen (which looks like "no puzzle at all").
        puzzle["fen"] = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    if puzzle.get("reward") is None:
        puzzle["reward"] = settings.get("puzzle_base_reward", 15) + (puzzle.get("difficulty", 1) - 1) * int(settings.get("puzzle_reward_scale", 3))
    return puzzle

# A puzzle document counts as "broken" - a leftover placeholder rather than
# an actual tactic - if it has no solution to check against (solve_puzzle
# would then never be able to mark it correct) or its position is just the
# plain starting position (no tactic to find at all). Compared on just the
# piece-placement field (the part before the first space), not the full FEN
# string - an exact full-FEN match is brittle: two starting positions can
# have the same arrangement of pieces but differ in castling rights, en
# passant, or move-clock digits depending on how/when they were written.
_STANDARD_START_PLACEMENT = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR"

def _puzzle_doc_is_broken(doc: dict) -> bool:
    solution = doc.get("solution")
    fen = (doc.get("fen") or "").strip()
    if not fen:
        return True
    # solution must be a non-empty LIST of moves. Docs from the previous
    # single-string-answer format (e.g. solution="Nxf6") fail this check
    # too, which is intentional - the repair pass below regenerates them
    # into real move sequences instead of leaving them stuck as one-shot
    # answers.
    if not solution or not isinstance(solution, list) or not any((m or "").strip() for m in solution):
        return True
    placement = fen.split(" ")[0].strip()
    return placement == _STANDARD_START_PLACEMENT

async def repair_broken_puzzles(settings: dict, force: bool = False):
    """One-time repair pass for puzzle documents seeded before the current
    tactic-template generator existed. Those old docs are just a
    placeholder starting-position FEN with no `solution`, which means the
    board renders as a plain, un-annotated starting position (chess.js
    can't load an invalid FEN and silently keeps its own default board)
    and the puzzle can never be solved (solve_puzzle compares directly
    against the raw, empty `solution` field). Regenerates each broken
    doc's content from the real template list in place, keeping its
    puzzle_id/difficulty stable so ordering and progress aren't disturbed.

    Gated by a marker document so this heavier scan only actually runs
    once - seed_puzzles_if_needed calls this on every /puzzles/next
    request, and re-scanning up to 10000 documents on every request would
    be wasteful once the collection is already clean. Pass force=True
    (e.g. from the admin re-seed endpoint) to bypass the marker and
    re-scan on demand. force=True also treats every document as needing
    regeneration rather than only the literally-broken ones: a doc can
    have a valid, non-starting fen and a real solution and still just be
    stale placeholder content from an older template list, which
    _puzzle_doc_is_broken has no way to detect on its own. That's the only
    way a content refresh (e.g. swapping in real tactics) ever reaches an
    already-seeded database instead of only affecting brand-new ones.

    The scan itself pulls every doc's fen/solution and filters in Python
    (see _puzzle_doc_is_broken) rather than relying on an exact-string
    Mongo query, since the whole point is that "starting position" can be
    spelled several slightly different ways in the FEN's trailing fields."""
    if not force:
        # v2: bumped from puzzle_repair_v1 because that marker was already
        # set "done" in existing databases seeded before puzzles carried a
        # full move-sequence solution. Without bumping the marker, every
        # already-seeded puzzle would keep its old single-move "solution"
        # string forever and /puzzles/attempts/{id}/move would never be
        # able to match it (it expects a list). This forces one more full
        # scan so existing data actually gets upgraded.
        marker = await db.settings.find_one({"type": "puzzle_repair_v2"})
        if marker and marker.get("done"):
            return 0

    all_docs = await db.puzzles.find(
        {}, {"_id": 0, "puzzle_id": 1, "difficulty": 1, "fen": 1, "solution": 1}
    ).to_list(20000)
    broken = all_docs if force else [d for d in all_docs if _puzzle_doc_is_broken(d)]

    repaired = 0
    for doc in broken:
        puzzle_id = doc.get("puzzle_id")
        if not puzzle_id:
            continue
        try:
            index = int(str(puzzle_id).rsplit("_", 1)[-1]) - 1
        except (ValueError, IndexError):
            index = random.randrange(10000)

        fresh = await build_puzzle_doc(index, settings)
        fresh["puzzle_id"] = puzzle_id  # keep this document's identity stable
        if doc.get("difficulty") is not None:
            fresh["difficulty"] = doc["difficulty"]  # preserve its existing bucket

        await db.puzzles.update_one({"puzzle_id": puzzle_id}, {"$set": fresh})
        repaired += 1

    await db.settings.update_one(
        {"type": "puzzle_repair_v2"},
        {"$set": {"type": "puzzle_repair_v2", "done": True, "repaired_count": repaired, "ran_at": datetime.now(timezone.utc).isoformat()}},
        upsert=True
    )
    logger.info(f"Repaired {repaired} broken/placeholder puzzle documents")
    return repaired

async def seed_puzzles_if_needed(settings: dict, force_repair: bool = False):
    current_count = await db.puzzles.count_documents({})
    if current_count < 10000:
        batch_size = 500
        docs = []
        for index in range(current_count, 10000):
            docs.append(await build_puzzle_doc(index, settings))
            if len(docs) >= batch_size:
                await db.puzzles.insert_many(docs)
                docs = []
        if docs:
            await db.puzzles.insert_many(docs)

    return await repair_broken_puzzles(settings, force=force_repair)


async def create_tournament_game(tournament: dict, white_player: dict, black_player: dict) -> str:
    game_id = f"game_{uuid.uuid4().hex[:12]}"
    base_time = int(tournament["time_control"].split("+")[0]) * 60
    game_doc = {
        "game_id": game_id,
        "white_player": white_player,
        "black_player": black_player,
        "time_control": tournament["time_control"],
        "stake_amount": 0,
        "stake_currency": tournament["entry_currency"],
        "arbiter_fee": 0.0,
        "status": "active",
        "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        "moves": [],
        "move_times": [],
        # Phase 4e: pre-move fen/clock snapshots, pushed to in make_move -
        # what takeback_token pops back to. Present on every game doc from
        # creation so make_move never has to special-case a missing array.
        "fen_history": [],
        "clock_history": [],
        "white_time": base_time,
        "black_time": base_time,
        "current_turn": "white",
        "result": None,
        "winner_id": None,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "is_private": False,
        "game_type": "tournament",
        "tournament_id": tournament["tournament_id"]
    }
    await db.games.insert_one(game_doc)

    # Notify both players about their tournament match assignment
    if white_player and white_player.get("user_id"):
        await sio.emit('tournament_match_assigned', {
            "tournament_id": tournament["tournament_id"],
            "game_id": game_id,
            "color": "white",
            "opponent": black_player,
            "time_control": tournament["time_control"]
        }, room=f"user_{white_player['user_id']}")

    if black_player and black_player.get("user_id"):
        await sio.emit('tournament_match_assigned', {
            "tournament_id": tournament["tournament_id"],
            "game_id": game_id,
            "color": "black",
            "opponent": white_player,
            "time_control": tournament["time_control"]
        }, room=f"user_{black_player['user_id']}")

    return game_id

async def update_tournament_leaderboard_for_game(game: dict):
    tournament_id = game.get("tournament_id")
    if not tournament_id:
        return

    tournament = await db.tournaments.find_one({"tournament_id": tournament_id}, {"_id": 0})
    if not tournament:
        return

    leaderboard = tournament.get("leaderboard", [])
    white_id = game["white_player"]["user_id"]
    black_player = game.get("black_player")
    black_id = black_player["user_id"] if black_player else None

    if game["result"] == "white":
        white_delta, black_delta = 1.0, 0.0
        white_outcome, black_outcome = "win", "loss"
    elif game["result"] == "black":
        white_delta, black_delta = 0.0, 1.0
        white_outcome, black_outcome = "loss", "win"
    elif game["result"] == "draw":
        white_delta, black_delta = 0.5, 0.5
        white_outcome, black_outcome = "draw", "draw"
    else:
        return

    outcome_field = {"win": "wins", "loss": "losses", "draw": "draws"}

    for entry in leaderboard:
        if entry["user_id"] == white_id:
            entry["score"] = entry.get("score", 0) + white_delta
            entry["games_played"] = entry.get("games_played", 0) + 1
            field = outcome_field[white_outcome]
            entry[field] = entry.get(field, 0) + 1
        if black_id and entry["user_id"] == black_id:
            entry["score"] = entry.get("score", 0) + black_delta
            entry["games_played"] = entry.get("games_played", 0) + 1
            field = outcome_field[black_outcome]
            entry[field] = entry.get(field, 0) + 1

    leaderboard = sorted(leaderboard, key=lambda x: -x.get("score", 0))
    updated_players = []
    for player in tournament.get("players", []):
        if player["user_id"] in {white_id, black_id}:
            player["current_game_id"] = None
            player["in_match"] = False
            # Keep the players list's games_played in sync with the
            # leaderboard's - auto_pair_tournament reads this field to decide
            # who gets paired next, so if it never advances here the fewest-
            # games-first priority silently breaks and the same couple of
            # players can end up facing each other over and over while a
            # third player never gets picked.
            player["games_played"] = player.get("games_played", 0) + 1
        updated_players.append(player)

    await db.tournaments.update_one(
        {"tournament_id": tournament_id},
        {"$set": {"leaderboard": leaderboard, "players": updated_players}}
    )

    await sio.emit('tournament_updated', {
        "tournament_id": tournament_id,
        "leaderboard": leaderboard
    })

    # Both players just freed up (in_match=False above) - immediately try to
    # pair them (and anyone else waiting) into a new match rather than
    # waiting for a player to click something. This is what keeps an arena
    # tournament running continuously until its duration runs out.
    await auto_pair_tournament(tournament_id)


async def activate_tournament(tournament: dict):
    """Generate the opening round of pairings and flip a tournament to
    active. Shared by the admin /start endpoint and the automatic scheduler
    tick, so scheduled/automated tournaments don't need an admin to start
    them by hand."""
    tournament_id = tournament["tournament_id"]
    end_time = (datetime.now(timezone.utc) + timedelta(minutes=tournament["duration_minutes"])).isoformat()
    pairings = generate_tournament_pairings(tournament.get("players", []))

    game_user_map = {}
    for pairing in pairings:
        if pairing.get("note") == "bye":
            continue
        white_player = pairing["player_white"]
        black_player = pairing["player_black"]
        game_id = await create_tournament_game(tournament, white_player, black_player)
        pairing["game_id"] = game_id
        game_user_map[white_player["user_id"]] = game_id
        game_user_map[black_player["user_id"]] = game_id

    updated_players = []
    for player in tournament.get("players", []):
        if player["user_id"] in game_user_map:
            player["current_game_id"] = game_user_map[player["user_id"]]
            player["in_match"] = True
        updated_players.append(player)

    actual_start_time = datetime.now(timezone.utc).isoformat()
    await db.tournaments.update_one(
        {"tournament_id": tournament_id},
        {
            "$set": {
                "status": "active",
                "start_time": actual_start_time,
                "end_time": end_time,
                "pairings": pairings,
                "players": updated_players
            }
        }
    )

    await sio.emit('tournament_started', {
        "tournament_id": tournament_id,
        "name": tournament.get("name"),
        "start_time": actual_start_time,
        "end_time": end_time,
        "pairings": pairings
    })

    if len(tournament.get("players", [])) % 2 != 0:
        await sio.emit('admin_alert', {
            "tournament_id": tournament_id,
            "message": "Tournament started with an odd participant count; one player is waiting for the next available opponent.",
            "name": tournament.get("name"),
            "current_players": tournament.get("current_players")
        }, room="admin_room")


async def finish_tournament(tournament: dict):
    """Distribute prizes and mark a tournament completed. Shared by the
    admin /end endpoint, the scheduler tick, and auto_pair_tournament's own
    end-time check - all of which can notice a tournament's time is up at
    roughly the same moment. The status flip below is done as one atomic,
    filtered update so only the caller that actually wins the race pays out
    the prize pool; everyone else sees modified_count == 0 and backs off,
    which is what prevents winners from being credited twice."""
    tournament_id = tournament["tournament_id"]

    claim = await db.tournaments.update_one(
        {"tournament_id": tournament_id, "status": {"$in": ["active", "upcoming"]}},
        {"$set": {"status": "completed", "end_time": datetime.now(timezone.utc).isoformat()}}
    )
    if claim.modified_count == 0:
        # Another caller already finished (and paid out) this tournament.
        return

    # Re-fetch so the leaderboard/prize_pool reflect the very latest state
    # rather than whatever snapshot the caller happened to pass in.
    fresh = await db.tournaments.find_one({"tournament_id": tournament_id}, {"_id": 0}) or tournament
    prize_pool = fresh.get("prize_pool", tournament.get("prize_pool", 0))
    leaderboard = sorted(fresh.get("leaderboard", tournament.get("leaderboard", [])), key=lambda x: -x.get("score", 0))
    entry_currency = fresh.get("entry_currency", tournament.get("entry_currency"))

    if len(leaderboard) >= 1 and prize_pool > 0:
        # 1st place: 50%, 2nd: 30%, 3rd: 20%
        distributions = [0.5, 0.3, 0.2]
        for i, pct in enumerate(distributions):
            if i < len(leaderboard):
                winner = leaderboard[i]
                prize = prize_pool * pct

                await db.users.update_one(
                    {"user_id": winner["user_id"]},
                    {"$inc": {f"wallet_balance.{entry_currency}": prize}}
                )

                await db.transactions.insert_one({
                    "tx_id": f"tx_{uuid.uuid4().hex[:12]}",
                    "user_id": winner["user_id"],
                    "tx_type": "tournament_prize",
                    "amount": prize,
                    "currency": entry_currency,
                    "status": "completed",
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "related_tournament_id": tournament_id
                })

    await sio.emit('tournament_ended', {
        "tournament_id": tournament_id,
        "name": tournament.get("name"),
        "leaderboard": leaderboard[:3]
    })


async def auto_pair_tournament(tournament_id: str):
    """Pair up every free player in an active arena tournament, right now -
    no lobby, no 'play' button. Called the instant a match ends and on a
    periodic scheduler tick (to catch players who just joined or a tick
    that raced a game-end). Stops pairing once the tournament's duration
    has run out, at which point it closes the tournament out instead."""
    tournament = await db.tournaments.find_one({"tournament_id": tournament_id}, {"_id": 0})
    if not tournament or tournament.get("status") != "active":
        return
    if tournament.get("tournament_type") != "arena":
        # Swiss-style tournaments pair in discrete admin-managed rounds,
        # not continuously - leave those alone here.
        return

    end_time = tournament.get("end_time")
    if end_time:
        try:
            if datetime.now(timezone.utc) >= datetime.fromisoformat(end_time):
                await finish_tournament(tournament)
                return
        except ValueError:
            pass

    players = tournament.get("players", [])
    waiting = [p for p in players if not p.get("in_match")]
    if len(waiting) < 2:
        return

    # Players who've played the fewest rounds so far get paired first, so
    # everyone cycles through roughly the same number of games instead of
    # a fast pair hogging matches while others sit idle.
    pool = sorted(waiting, key=lambda p: (p.get("games_played", 0), random.random()))

    players_by_id = {p["user_id"]: p for p in players}
    new_pairings = []

    while len(pool) >= 2:
        player = pool.pop(0)
        # Prefer someone the player hasn't just played, so with 3+ waiting
        # players a rematch doesn't repeatedly crowd out whoever's left -
        # only fall back to a same-opponent rematch if there's no one else
        # available this round.
        candidates = [i for i in range(len(pool)) if pool[i]["user_id"] != player.get("last_opponent_id")]
        if not candidates:
            candidates = list(range(len(pool)))
        opponent_idx = min(
            candidates,
            key=lambda i: abs(pool[i].get("rating", 1200) - player.get("rating", 1200))
        )
        opponent = pool.pop(opponent_idx)

        white_player, black_player = (
            (player, opponent) if player.get("rating", 1200) >= opponent.get("rating", 1200)
            else (opponent, player)
        )
        game_id = await create_tournament_game(tournament, white_player, black_player)
        new_pairings.append({
            "player_white": white_player,
            "player_black": black_player,
            "rating_difference": abs(white_player.get("rating", 1200) - black_player.get("rating", 1200)),
            "game_id": game_id
        })
        players_by_id[white_player["user_id"]]["current_game_id"] = game_id
        players_by_id[white_player["user_id"]]["in_match"] = True
        players_by_id[white_player["user_id"]]["last_opponent_id"] = black_player["user_id"]
        players_by_id[black_player["user_id"]]["current_game_id"] = game_id
        players_by_id[black_player["user_id"]]["in_match"] = True
        players_by_id[black_player["user_id"]]["last_opponent_id"] = white_player["user_id"]

    if not new_pairings:
        return

    await db.tournaments.update_one(
        {"tournament_id": tournament_id},
        {
            "$set": {"players": list(players_by_id.values())},
            "$push": {"pairings": {"$each": new_pairings}}
        }
    )

    await sio.emit('tournament_updated', {
        "tournament_id": tournament_id,
        "pairings": new_pairings
    })


async def tournament_scheduler_tick():
    """Runs every few seconds: auto-starts tournaments whose scheduled time
    has arrived, keeps active arena tournaments continuously paired, and
    closes out any tournament whose duration has elapsed. This is what lets
    a tournament run start-to-finish with nobody having to click anything."""
    now_iso = datetime.now(timezone.utc).isoformat()

    try:
        due = await db.tournaments.find({
            "status": "upcoming",
            "start_time": {"$lte": now_iso}
        }, {"_id": 0}).to_list(200)
        for t in due:
            if t.get("current_players", 0) >= max(2, t.get("min_players", 2)):
                try:
                    await activate_tournament(t)
                except Exception as e:
                    logger.error(f"Failed to auto-start tournament {t.get('tournament_id')}: {e}")
    except Exception as e:
        logger.error(f"Tournament auto-start sweep failed: {e}")

    try:
        active = await db.tournaments.find({"status": "active"}, {"_id": 0}).to_list(200)
        for t in active:
            try:
                end_time = t.get("end_time")
                if end_time and datetime.now(timezone.utc) >= datetime.fromisoformat(end_time):
                    await finish_tournament(t)
                elif t.get("tournament_type") == "arena":
                    await auto_pair_tournament(t["tournament_id"])
            except Exception as e:
                logger.error(f"Tournament tick failed for {t.get('tournament_id')}: {e}")
    except Exception as e:
        logger.error(f"Tournament active sweep failed: {e}")


async def get_current_user(request: Request) -> dict:
    token = request.cookies.get("session_token")
    
    if not token:
        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            token = auth_header.split(" ")[1]
    
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    session = await db.user_sessions.find_one({"session_token": token}, {"_id": 0})
    if session:
        expires_at = session.get("expires_at")
        if isinstance(expires_at, str):
            expires_at = datetime.fromisoformat(expires_at)
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at < datetime.now(timezone.utc):
            raise HTTPException(status_code=401, detail="Session expired")
        
        user = await db.users.find_one({"user_id": session["user_id"]}, {"_id": 0})
        if user:
            # Check if banned
            if user.get("is_banned"):
                raise HTTPException(status_code=403, detail="Account suspended")
            return user
    
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = payload.get("sub")
        if user_id is None:
            raise HTTPException(status_code=401, detail="Invalid token")
        
        user = await db.users.find_one({"user_id": user_id}, {"_id": 0})
        if user is None:
            raise HTTPException(status_code=401, detail="User not found")
        if user.get("is_banned"):
            raise HTTPException(status_code=403, detail="Account suspended")
        return user
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")

async def get_admin_user(request: Request) -> dict:
    user = await get_current_user(request)
    if not user.get("is_admin", False):
        raise HTTPException(status_code=403, detail="Admin access required")
    return user

def calculate_elo_change(winner_rating: int, loser_rating: int, k: int = 32) -> tuple:
    expected_winner = 1 / (1 + 10 ** ((loser_rating - winner_rating) / 400))
    expected_loser = 1 - expected_winner
    winner_change = round(k * (1 - expected_winner))
    loser_change = round(k * (0 - expected_loser))
    return winner_change, loser_change

# ============= ANTI-CHEAT FUNCTIONS =============

def analyze_moves_with_stockfish(moves: List[str], fen_positions: List[str] = None) -> Dict:
    """Analyze game moves using Stockfish engine"""
    engine = get_stockfish()
    if not engine:
        return {"engine_available": False, "accuracy": None, "cpl": None}
    
    try:
        from chess import Board
        board = Board()
        
        total_cpl = 0  # Centipawn loss
        engine_matches = 0
        analyzed_moves = 0
        
        for i, move_uci in enumerate(moves):
            try:
                engine.set_fen_position(board.fen())
                best_move = engine.get_best_move()
                eval_before = engine.get_evaluation()
                board.push_uci(move_uci)
                engine.set_fen_position(board.fen())
                eval_after = engine.get_evaluation()
                
                if eval_before and eval_after:
                    if eval_before.get("type") == "cp" and eval_after.get("type") == "cp":
                        cpl = abs(eval_before["value"] - eval_after["value"])
                        total_cpl += min(cpl, 500)
                        analyzed_moves += 1
                
                if best_move == move_uci:
                    engine_matches += 1
            except Exception as e:
                logger.debug(f"Move analysis error: {e}")
                continue
        
        avg_cpl = total_cpl / analyzed_moves if analyzed_moves > 0 else None
        accuracy = (engine_matches / len(moves) * 100) if moves else 0
        
        return {
            "engine_available": True,
            "accuracy": accuracy,
            "cpl": avg_cpl,
            "engine_matches": engine_matches,
            "total_moves": len(moves),
            "analyzed_moves": analyzed_moves
        }
    except Exception as e:
        logger.error(f"Stockfish analysis error: {e}")
        return {"engine_available": False, "error": str(e)}


def get_opening_book_moves(fen: str) -> List[str]:
    """Return a small set of opening book moves for early positions."""
    book = {
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1": ["e2e4", "d2d4", "g1f3", "c2c4"],
        "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1": ["e7e5", "c7c5", "e7e6", "c7c6"],
        "rnbqkbnr/pppp1ppp/8/4p3/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2": ["d4e5", "g1f3", "c2c3"],
    }
    return book.get(fen, [])


# Per-game locks so two concurrent requests for the SAME game don't both spin up a
# blocking Stockfish run (this also protects against front-end retry storms).
_analysis_locks: Dict[str, asyncio.Lock] = {}


def _get_analysis_lock(game_id: str) -> asyncio.Lock:
    lock = _analysis_locks.get(game_id)
    if lock is None:
        lock = asyncio.Lock()
        _analysis_locks[game_id] = lock
    return lock


def analyze_game_with_stockfish(moves: List[str], starting_fen: str = None, depth: int = 12) -> Dict:
    """Perform a detailed per-move Stockfish analysis and classify moves.
    Returns per-move info: best_move, eval_before, eval_after, cp_loss, category, book_move
    Categories: best, brilliant, inaccuracy, mistake, blunder, book
    """
    global STOCKFISH_PATH, STOCKFISH_AVAILABLE
    if not STOCKFISH_AVAILABLE or not STOCKFISH_PATH or not os.path.exists(STOCKFISH_PATH):
        resolved = resolve_stockfish_path()
        STOCKFISH_PATH = resolved
        STOCKFISH_AVAILABLE = bool(Stockfish is not None and STOCKFISH_PATH and os.path.exists(STOCKFISH_PATH))

    if not STOCKFISH_AVAILABLE or not STOCKFISH_PATH:
        return {"engine_available": False, "error": "Stockfish not available"}

    try:
        from chess import Board
        # Hash halved from the historical 128MB - see
        # _stockfish_job_slots's docstring for why (memory headroom on a
        # 512MB Render instance). Every caller of this function already
        # goes through that semaphore, so at most one of these runs at a
        # time regardless.
        local_engine = Stockfish(path=STOCKFISH_PATH, depth=depth, parameters={"Threads": 2, "Hash": 64})
        board = Board() if not starting_fen else Board(fen=starting_fen)
        results = []
        summary = {"best": 0, "brilliant": 0, "inaccuracy": 0, "mistake": 0, "blunder": 0}
        book_moves = get_opening_book_moves(board.fen())

        for idx, move_uci in enumerate(moves):
            try:
                local_engine.set_fen_position(board.fen())
                best_move = local_engine.get_best_move()
                top_moves = local_engine.get_top_moves(3)
                eval_before = local_engine.get_evaluation() or {}
                board.push_uci(move_uci)
                local_engine.set_fen_position(board.fen())
                eval_after = local_engine.get_evaluation() or {}

                cp_loss = None
                score_delta = None
                if eval_before.get("type") == "cp" and eval_after.get("type") == "cp":
                    cp_loss = abs(eval_before.get("value", 0) - eval_after.get("value", 0))
                    score_delta = eval_after["value"] - eval_before["value"]
                elif eval_before.get("type") == "mate" and eval_after.get("type") == "mate":
                    cp_loss = 0
                    score_delta = 0

                category = "best"
                if best_move == move_uci:
                    summary["best"] += 1
                    if score_delta is not None and score_delta >= 150:
                        category = "brilliant"
                        summary["brilliant"] += 1
                else:
                    if cp_loss is None:
                        category = "inaccuracy"
                        summary["inaccuracy"] += 1
                    elif cp_loss <= 50:
                        category = "inaccuracy"
                        summary["inaccuracy"] += 1
                    elif cp_loss <= 200:
                        category = "mistake"
                        summary["mistake"] += 1
                    else:
                        category = "blunder"
                        summary["blunder"] += 1

                if best_move in book_moves and best_move == move_uci:
                    category = "book"

                results.append({
                    "move_index": idx + 1,
                    "move": move_uci,
                    "best_move": best_move,
                    "top_moves": top_moves,
                    "eval_before": eval_before,
                    "eval_after": eval_after,
                    "cp_loss": cp_loss,
                    "score_delta": score_delta,
                    "category": category,
                    "book_move": best_move in book_moves
                })
            except Exception as e:
                logger.debug(f"Per-move analysis error at move {idx}: {e}")
                results.append({"move_index": idx + 1, "move": move_uci, "error": str(e)})
                continue

        return {
            "engine_available": True,
            "depth": depth,
            "moves": results,
            "summary": summary,
            "total_moves": len(moves),
            "opening_book_moves": book_moves,
        }
    except Exception as e:
        logger.exception("Detailed Stockfish analysis failed")
        return {"engine_available": False, "error": str(e)}

async def analyze_player_behavior(user_id: str) -> Dict:
    """Analyze player for potential cheating"""
    # Get recent games
    games = await db.games.find({
        "$or": [
            {"white_player.user_id": user_id},
            {"black_player.user_id": user_id}
        ],
        "status": "completed"
    }, {"_id": 0}).sort("created_at", -1).limit(20).to_list(20)
    
    if len(games) < 5:
        return {"flagged": False, "reasons": [], "score": 0}
    
    reasons = []
    score = 0
    
    # 1. Win Rate Analysis
    wins = sum(1 for g in games if g.get("winner_id") == user_id)
    win_rate = wins / len(games)
    
    if win_rate > 0.9 and len(games) >= 10:
        reasons.append(f"Suspicious win rate: {win_rate*100:.1f}%")
        score += 30
    
    # 2. Move Time Consistency Analysis
    all_move_times = []
    for game in games:
        is_white = game.get("white_player", {}).get("user_id") == user_id
        move_times = game.get("move_times", [])
        # Get player's move times (odd indices for white, even for black)
        start_idx = 0 if is_white else 1
        player_times = move_times[start_idx::2] if move_times else []
        all_move_times.extend(player_times)
    
    if len(all_move_times) >= 20:
        # Check for unnaturally consistent timing
        try:
            std_dev = statistics.stdev(all_move_times)
            mean_time = statistics.mean(all_move_times)
            cv = std_dev / mean_time if mean_time > 0 else 0
            
            # Engine users often have very consistent timing
            if cv < 0.15 and mean_time < 3:
                reasons.append(f"Suspicious move timing consistency (CV: {cv:.2f})")
                score += 25
        except:
            pass
    
    # 3. Rapid improvement detection
    user = await db.users.find_one({"user_id": user_id}, {"_id": 0})
    if user:
        created_at = user.get("created_at")
        if created_at:
            if isinstance(created_at, str):
                created_at = datetime.fromisoformat(created_at)
            days_since_creation = (datetime.now(timezone.utc) - created_at.replace(tzinfo=timezone.utc)).days
            
            # New account with high rating is suspicious
            if days_since_creation < 7 and user.get("rating", 1200) > 1600:
                reasons.append(f"New account with high rating ({user.get('rating')})")
                score += 20
    
    # 4. Check for abandonment pattern (potential match fixing)
    abandoned_games = await db.games.count_documents({
        "$or": [
            {"white_player.user_id": user_id},
            {"black_player.user_id": user_id}
        ],
        "end_reason": "abandonment",
        "created_at": {"$gte": (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()}
    })
    
    if abandoned_games >= 3:
        reasons.append(f"Multiple abandoned games: {abandoned_games}")
        score += 15
    
    # 5. Stockfish-based move accuracy analysis
    if STOCKFISH_AVAILABLE:
        # Get the most recent game with moves
        recent_game = None
        for game in games:
            if game.get("moves") and len(game.get("moves", [])) >= 10:
                recent_game = game
                break
        
        if recent_game:
            is_white = recent_game.get("white_player", {}).get("user_id") == user_id
            # Get player's moves (alternating)
            all_moves = recent_game.get("moves", [])
            player_moves = all_moves[0::2] if is_white else all_moves[1::2]
            
            if len(player_moves) >= 5:
                # Run Stockfish analysis on game
                analysis = analyze_moves_with_stockfish(all_moves)
                
                if analysis.get("engine_available"):
                    accuracy = analysis.get("accuracy", 0)
                    cpl = analysis.get("cpl")
                    
                    # Very high accuracy (>90%) is suspicious
                    if accuracy >= 90:
                        reasons.append(f"Engine-like move accuracy: {accuracy:.1f}%")
                        score += 35
                    elif accuracy >= 80:
                        reasons.append(f"High move accuracy: {accuracy:.1f}%")
                        score += 15
                    
                    # Very low centipawn loss is suspicious
                    if cpl is not None and cpl < 15:
                        reasons.append(f"Suspicious low centipawn loss: {cpl:.1f}")
                        score += 25
    
    return {
        "flagged": score >= 50,
        "reasons": reasons,
        "score": score,
        "stockfish_available": STOCKFISH_AVAILABLE
    }

async def flag_suspicious_player(user_id: str, reasons: List[str]):
    """Flag a player for admin review"""
    await db.users.update_one(
        {"user_id": user_id},
        {"$set": {"is_flagged": True}}
    )
    
    await db.anticheat_flags.insert_one({
        "flag_id": f"flag_{uuid.uuid4().hex[:12]}",
        "user_id": user_id,
        "reasons": reasons,
        "status": "pending",
        "created_at": datetime.now(timezone.utc).isoformat()
    })
    
    logger.warning(f"Player {user_id} flagged for review: {reasons}")

# ============= SECURITY FUNCTIONS =============

async def check_ip_abuse(request: Request, user_id: str) -> bool:
    """Check for multiple accounts from same IP"""
    client_ip = request.client.host if request.client else "unknown"
    
    # Record IP
    await db.user_ips.update_one(
        {"user_id": user_id},
        {
            "$set": {"last_ip": client_ip, "updated_at": datetime.now(timezone.utc).isoformat()},
            "$addToSet": {"ips": client_ip}
        },
        upsert=True
    )
    
    # Check if IP has multiple accounts
    accounts_with_ip = await db.user_ips.count_documents({"ips": client_ip})
    
    if accounts_with_ip > 3:
        await db.security_alerts.insert_one({
            "alert_id": f"alert_{uuid.uuid4().hex[:12]}",
            "type": "multiple_accounts",
            "ip": client_ip,
            "user_id": user_id,
            "accounts_count": accounts_with_ip,
            "created_at": datetime.now(timezone.utc).isoformat()
        })
        return True
    
    return False

async def apply_abandonment_penalty(user_id: str, game_id: str, stake_amount: float, currency: str):
    """Apply penalty for abandoning a game"""
    # Forfeit stake
    if stake_amount > 0:
        # Winner gets the pot
        game = await db.games.find_one({"game_id": game_id}, {"_id": 0})
        if game:
            opponent_id = None
            if game["white_player"]["user_id"] == user_id:
                opponent_id = game["black_player"]["user_id"]
            else:
                opponent_id = game["white_player"]["user_id"]
            
            if opponent_id:
                total_pot = stake_amount * 2
                arbiter_fee = total_pot * 0.02
                winner_amount = total_pot - arbiter_fee
                
                await db.users.update_one(
                    {"user_id": opponent_id},
                    {"$inc": {f"wallet_balance.{currency}": winner_amount}}
                )
    
    # Record abandonment
    await db.abandonments.insert_one({
        "user_id": user_id,
        "game_id": game_id,
        "created_at": datetime.now(timezone.utc).isoformat()
    })
    
    # Check total abandonments
    total_abandonments = await db.abandonments.count_documents({
        "user_id": user_id,
        "created_at": {"$gte": (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()}
    })
    
    # Auto-ban if too many abandonments
    if total_abandonments >= 5:
        await db.users.update_one(
            {"user_id": user_id},
            {"$set": {"is_banned": True, "ban_reason": "Excessive game abandonment"}}
        )
        logger.warning(f"User {user_id} auto-banned for excessive abandonment")

# ============= AUTH ROUTES =============

@api_router.post("/auth/register", response_model=TokenResponse)
async def register(request: Request, user_data: UserCreate, response: Response):
    existing_user = await db.users.find_one({"$or": [
        {"email": user_data.email},
        {"username": user_data.name}
    ]})
    
    if existing_user:
        if existing_user.get("email") == user_data.email:
            raise HTTPException(status_code=400, detail="Email already registered")
        raise HTTPException(status_code=400, detail="Username already taken")
    
    user_id = f"user_{uuid.uuid4().hex[:12]}"
    hashed_password = get_password_hash(user_data.password)
    
    user_doc = {
        "user_id": user_id,
        "username": user_data.name,
        "email": user_data.email,
        "password": hashed_password,
        "rating": 1200,
        "games_played": 0,
        "wins": 0,
        "losses": 0,
        "draws": 0,
        "wallet_balance": {"USDT": 100.0, "BTC": 0.001, "ETH": 0.01},
        "credits_balance": 0,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "is_admin": False,
        "is_flagged": False,
        "is_banned": False
    }
    
    await db.users.insert_one(user_doc)

    # Signup bonus: 400 free credits, granted once here at account creation.
    bonus_entry = await grant_credits(user_id, SIGNUP_BONUS_CREDITS, "signup_bonus")
    user_doc["credits_balance"] = bonus_entry["resulting_balance"]

    # Track IP
    await check_ip_abuse(request, user_id)
    
    access_token = create_access_token({"sub": user_id})

    await db.user_sessions.insert_one({
        "user_id": user_id,
        "session_token": access_token,
        "expires_at": (datetime.now(timezone.utc) + timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS)).isoformat(),
        "created_at": datetime.now(timezone.utc).isoformat()
    })

    secure_cookie = os.environ.get('USE_SECURE_COOKIES', 'false').lower() in ('true','1','yes')
    cookie_same_site = "none" if secure_cookie else "lax"
    response.set_cookie(
        key="session_token",
        value=access_token,
        httponly=True,
        secure=secure_cookie,
        samesite=cookie_same_site,
        path="/",
        max_age=ACCESS_TOKEN_EXPIRE_HOURS * 3600
    )
    user_doc.pop("password", None)
    user_doc.pop("_id", None)
    
    return TokenResponse(access_token=access_token, user=UserResponse(**user_doc))

@api_router.post("/auth/login", response_model=TokenResponse)
async def login(request: Request, user_data: UserLogin, response: Response):
    user = await db.users.find_one({"email": user_data.email}, {"_id": 0})
    
    if not user or not verify_password(user_data.password, user.get("password", "")):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    
    if user.get("is_banned"):
        raise HTTPException(status_code=403, detail="Account suspended")
    
    # Track IP
    await check_ip_abuse(request, user["user_id"])
    
    access_token = create_access_token({"sub": user["user_id"]})
    
    secure_cookie = os.environ.get('USE_SECURE_COOKIES', 'false').lower() in ('true','1','yes')
    cookie_same_site = "none" if secure_cookie else "lax"
    response.set_cookie(
        key="session_token",
        value=access_token,
        httponly=True,
        secure=secure_cookie,
        samesite=cookie_same_site,
        path="/",
        max_age=ACCESS_TOKEN_EXPIRE_HOURS * 3600
    )
    
    user.pop("password", None)
    
    return TokenResponse(access_token=access_token, user=UserResponse(**user))

@api_router.get("/auth/me", response_model=UserResponse)
async def get_me(request: Request):
    user = await get_current_user(request)
    user.pop("password", None)
    return UserResponse(**user)

@api_router.post("/auth/logout")
async def logout(request: Request, response: Response):
    token = request.cookies.get("session_token")
    if token:
        await db.user_sessions.delete_one({"session_token": token})
    
    response.delete_cookie(key="session_token", path="/")
    return {"message": "Logged out successfully"}

async def resolve_oauth_session(session_id: str) -> dict:
    """
    Resolve OAuth session by looking up session_id in the database.
    
    This supports two modes:
    1. Direct OAuth session storage (for testing/internal OAuth flows)
    2. Can be extended to call external OAuth providers (Google, etc.)
    
    Returns a dict shaped like:
        {
            "email": str,               # required
            "name": str | None,         # optional display name
            "picture": str | None,      # optional avatar URL
            "session_token": str | None # optional; a random token is
                                         # generated below if omitted
        }
    Raises HTTPException(status_code=401, ...) on failure.
    """
    # Look up the session in the oauth_sessions collection
    oauth_session = await db.oauth_sessions.find_one({
        "session_id": session_id,
        "expires_at": {"$gt": datetime.now(timezone.utc).isoformat()}
    })
    
    if not oauth_session:
        raise HTTPException(status_code=401, detail="Invalid or expired session ID")
    
    # Extract user data from the session
    return {
        "email": oauth_session.get("email"),
        "name": oauth_session.get("name"),
        "picture": oauth_session.get("picture"),
        "session_token": oauth_session.get("session_token")
    }


def build_redirect_url_with_session(redirect_uri: str, session_id: str) -> str:
    if not redirect_uri:
        redirect_uri = "http://localhost:3000/callback"

    url_without_query, _, current_query = redirect_uri.partition("?")
    params = parse_qs(current_query)
    params["session_id"] = [session_id]
    return f"{url_without_query}?{urlencode(params, doseq=True)}"


async def create_oauth_session_record(email: str, name: Optional[str] = None, picture: Optional[str] = None, session_token: Optional[str] = None) -> str:
    session_id = f"oauth_{uuid.uuid4().hex}"
    expires_at = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    if session_token is None:
        session_token = f"oauth_{uuid.uuid4().hex}"

    await db.oauth_sessions.insert_one({
        "session_id": session_id,
        "email": email,
        "name": name or email.split("@")[0],
        "picture": picture,
        "session_token": session_token,
        "expires_at": expires_at,
        "created_at": datetime.now(timezone.utc).isoformat()
    })
    return session_id


@api_router.get("/auth/google/start")
async def google_oauth_start(request: Request):
    """Start Google sign-in with a real provider when configured, otherwise use a local fallback flow."""
    redirect_uri = request.query_params.get("redirect_uri") or "http://localhost:3000/callback"
    google_client_id = os.environ.get("GOOGLE_CLIENT_ID")
    google_client_secret = os.environ.get("GOOGLE_CLIENT_SECRET")

    if google_client_id and google_client_secret:
        state = uuid.uuid4().hex
        params = {
            "client_id": google_client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": "openid email profile",
            "access_type": "online",
            "prompt": "select_account",
            "state": state,
        }
        return {
            "redirect_url": f"https://accounts.google.com/o/oauth2/v2/auth?{urlencode(params)}",
            "state": state,
        }

    fallback_email = f"google_user_{uuid.uuid4().hex[:12]}@gmail.com"
    session_id = await create_oauth_session_record(
        email=fallback_email,
        name="Google User",
        picture=None,
        session_token=f"oauth_{uuid.uuid4().hex}"
    )
    return {
        "redirect_url": build_redirect_url_with_session(redirect_uri, session_id),
        "session_id": session_id,
    }


@api_router.get("/auth/google/callback")
async def google_oauth_callback(request: Request):
    """Complete Google sign-in when credentials are configured. If no Google provider is configured, this route still supports the local fallback."""
    code = request.query_params.get("code")
    redirect_uri = request.query_params.get("redirect_uri") or "http://localhost:3000/callback"
    google_client_id = os.environ.get("GOOGLE_CLIENT_ID")
    google_client_secret = os.environ.get("GOOGLE_CLIENT_SECRET")

    if not google_client_id or not google_client_secret:
        fallback_email = f"google_user_{uuid.uuid4().hex[:12]}@gmail.com"
        session_id = await create_oauth_session_record(
            email=fallback_email,
            name="Google User",
            picture=None,
            session_token=f"oauth_{uuid.uuid4().hex}"
        )
        return {"redirect_url": build_redirect_url_with_session(redirect_uri, session_id), "session_id": session_id}

    if not code:
        raise HTTPException(status_code=400, detail="Google auth code required")

    token_response = requests.post(
        "https://oauth2.googleapis.com/token",
        data={
            "code": code,
            "client_id": google_client_id,
            "client_secret": google_client_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        },
        timeout=20,
    )
    token_response.raise_for_status()
    token_data = token_response.json()
    access_token = token_data.get("access_token")
    if not access_token:
        raise HTTPException(status_code=400, detail="Google token exchange failed")

    userinfo_response = requests.get(
        "https://openidconnect.googleapis.com/v1/userinfo",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=20,
    )
    userinfo_response.raise_for_status()
    userinfo = userinfo_response.json()

    email = userinfo.get("email")
    if not email:
        raise HTTPException(status_code=400, detail="Google account email not available")

    session_id = await create_oauth_session_record(
        email=email,
        name=userinfo.get("name") or userinfo.get("given_name") or email.split("@")[0],
        picture=userinfo.get("picture"),
        session_token=f"oauth_{uuid.uuid4().hex}"
    )
    return {"redirect_url": build_redirect_url_with_session(redirect_uri, session_id), "session_id": session_id}


@api_router.post("/auth/session", response_model=TokenResponse)
async def create_session(request: Request, response: Response):
    body = await request.json()
    session_id = body.get("session_id")
    
    if not session_id:
        raise HTTPException(status_code=400, detail="Session ID required")

    try:
        oauth_data = await resolve_oauth_session(session_id)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"OAuth error: {e}")
        raise HTTPException(status_code=401, detail="OAuth validation failed")

    email = oauth_data.get("email")
    session_token = oauth_data.get("session_token") or f"oauth_{uuid.uuid4().hex}"
    user = await db.users.find_one({"email": email}, {"_id": 0})
    
    if not user:
        user_id = f"user_{uuid.uuid4().hex[:12]}"
        user = {
            "user_id": user_id,
            "username": oauth_data.get("name", email.split("@")[0]),
            "email": email,
            "picture": oauth_data.get("picture"),
            "rating": 1200,
            "games_played": 0,
            "wins": 0,
            "losses": 0,
            "draws": 0,
            "wallet_balance": {"USDT": 100.0, "BTC": 0.001, "ETH": 0.01},
            "credits_balance": 0,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "is_admin": False,
            "is_flagged": False,
            "is_banned": False
        }
        await db.users.insert_one(user)
        # Signup bonus: 400 free credits, granted once here at account creation.
        await grant_credits(user_id, SIGNUP_BONUS_CREDITS, "signup_bonus")
        user = await db.users.find_one({"user_id": user_id}, {"_id": 0})
    
    if user.get("is_banned"):
        raise HTTPException(status_code=403, detail="Account suspended")
    
    await db.user_sessions.insert_one({
        "user_id": user["user_id"],
        "session_token": session_token,
        "expires_at": (datetime.now(timezone.utc) + timedelta(days=7)).isoformat(),
        "created_at": datetime.now(timezone.utc).isoformat()
    })
    
    secure_cookie = os.environ.get('USE_SECURE_COOKIES', 'false').lower() in ('true','1','yes')
    cookie_same_site = "none" if secure_cookie else "lax"

    response.set_cookie(
        key="session_token",
        value=session_token,
        httponly=True,
        secure=secure_cookie,
        samesite=cookie_same_site,
        path="/",
        max_age=7 * 24 * 3600
    )

    access_token = create_access_token({"sub": user["user_id"]})
    user.pop("password", None)
    return TokenResponse(access_token=access_token, user=UserResponse(**user))

@api_router.post("/auth/create-oauth-session")
async def create_oauth_session_test(request: Request):
    """
    Test endpoint to create OAuth sessions for testing/development.
    
    In production, this would be called by an external OAuth provider.
    
    Payload: {
        "email": "user@example.com",
        "name": "User Name",  # optional
        "picture": "https://example.com/pic.jpg"  # optional
    }
    
    Returns: {
        "session_id": "oauth_xxxxx",
        "redirect_url": "http://localhost:3000/auth?session_id=oauth_xxxxx"
    }
    """
    body = await request.json()
    email = body.get("email")
    
    if not email:
        raise HTTPException(status_code=400, detail="Email is required")
    
    session_id = f"oauth_{uuid.uuid4().hex}"
    expires_at = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    
    # Store the OAuth session
    await db.oauth_sessions.insert_one({
        "session_id": session_id,
        "email": email,
        "name": body.get("name", email.split("@")[0]),
        "picture": body.get("picture"),
        "expires_at": expires_at,
        "created_at": datetime.now(timezone.utc).isoformat()
    })
    
    return {
        "session_id": session_id,
        "redirect_url": f"http://localhost:3000/auth?session_id={session_id}#session_id={session_id}"
    }

# ============= GAME ROUTES =============

# ============= GAME CREATION RATE LIMITING =============
# Simple in-memory sliding-window limiter: caps how many games a single
# account can create in a rolling window. This is intentionally in-process
# (not Redis-backed) - fine for a single-server deployment, and cheap enough
# to add without a new dependency. If you run multiple API processes/workers,
# swap this for a shared store (Redis INCR + TTL) so the limit is enforced
# across all of them instead of per-process.
GAME_CREATION_RATE_LIMIT = 5          # max games per user...
GAME_CREATION_RATE_WINDOW_SECONDS = 60  # ...per rolling window
_game_creation_timestamps: dict[str, list[float]] = {}


def _enforce_game_creation_rate_limit(user_id: str) -> None:
    now = datetime.now(timezone.utc).timestamp()
    window_start = now - GAME_CREATION_RATE_WINDOW_SECONDS

    recent = [ts for ts in _game_creation_timestamps.get(user_id, []) if ts > window_start]

    if len(recent) >= GAME_CREATION_RATE_LIMIT:
        raise HTTPException(
            status_code=429,
            detail=f"Too many games created - limit is {GAME_CREATION_RATE_LIMIT} per {GAME_CREATION_RATE_WINDOW_SECONDS}s. Please wait and try again.",
        )

    recent.append(now)
    _game_creation_timestamps[user_id] = recent


@api_router.post("/games", response_model=GameResponse)
async def create_game(game_data: GameCreate, request: Request):
    user = await get_current_user(request)

    _enforce_game_creation_rate_limit(user["user_id"])

    parts = game_data.time_control.split("+")
    base_time = int(parts[0]) * 60
    
    if game_data.stake_amount > 0:
        balance = user.get("wallet_balance", {}).get(game_data.stake_currency, 0)
        if balance < game_data.stake_amount:
            raise HTTPException(status_code=400, detail="Insufficient balance")
        
        await db.users.update_one(
            {"user_id": user["user_id"]},
            {"$inc": {f"wallet_balance.{game_data.stake_currency}": -game_data.stake_amount}}
        )
        
        await db.transactions.insert_one({
            "tx_id": f"tx_{uuid.uuid4().hex[:12]}",
            "user_id": user["user_id"],
            "tx_type": "stake",
            "amount": -game_data.stake_amount,
            "currency": game_data.stake_currency,
            "status": "escrow",
            "created_at": datetime.now(timezone.utc).isoformat()
        })
    
    game_id = f"game_{uuid.uuid4().hex[:12]}"
    game_doc = {
        "game_id": game_id,
        "white_player": {
            "user_id": user["user_id"],
            "username": user["username"],
            "rating": user.get("rating", 1200),
            "allow_spectators": user.get("allow_spectators", True),
            "allow_chat_broadcast": user.get("allow_chat_broadcast", True),
        },
        "black_player": None,
        "time_control": game_data.time_control,
        "stake_amount": game_data.stake_amount,
        "stake_currency": game_data.stake_currency,
        "arbiter_fee": 0.02,
        "status": "waiting",
        "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        "moves": [],
        "move_times": [],
        # Phase 4e: see create_tournament_game for why these start empty.
        "fen_history": [],
        "clock_history": [],
        "white_time": base_time,
        "black_time": base_time,
        "current_turn": "white",
        "result": None,
        "winner_id": None,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "is_private": game_data.is_private,
        "game_type": game_data.game_type,
        "tournament_id": game_data.tournament_id
    }
    
    await db.games.insert_one(game_doc)
    game_doc.pop("_id", None)

    await sio.emit("game_created", game_doc)
    await emit_watchable_count_update()
    
    return GameResponse(**game_doc)

async def _activate_waiting_game(game_id: str, user: dict) -> dict:
    game = await db.games.find_one({"game_id": game_id}, {"_id": 0})
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    if game["status"] != "waiting":
        raise HTTPException(status_code=400, detail="Game is not available to join")
    if game["white_player"]["user_id"] == user["user_id"]:
        raise HTTPException(status_code=400, detail="Cannot join your own game")

    if game["stake_amount"] > 0:
        balance = user.get("wallet_balance", {}).get(game["stake_currency"], 0)
        if balance < game["stake_amount"]:
            raise HTTPException(status_code=400, detail="Insufficient balance")

        await db.users.update_one(
            {"user_id": user["user_id"]},
            {"$inc": {f"wallet_balance.{game['stake_currency']}": -game["stake_amount"]}}
        )
        await db.transactions.insert_one({
            "tx_id": f"tx_{uuid.uuid4().hex[:12]}",
            "user_id": user["user_id"],
            "tx_type": "stake",
            "amount": -game["stake_amount"],
            "currency": game["stake_currency"],
            "status": "escrow",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "related_game_id": game_id
        })

    await db.games.update_one(
        {"game_id": game_id},
        {
            "$set": {
                "black_player": {
                    "user_id": user["user_id"],
                    "username": user["username"],
                    "rating": user.get("rating", 1200),
                    "allow_spectators": user.get("allow_spectators", True),
                    "allow_chat_broadcast": user.get("allow_chat_broadcast", True),
                },
                "status": "active",
                "started_at": datetime.now(timezone.utc).isoformat()
            }
        }
    )

    activated_game = await db.games.find_one({"game_id": game_id}, {"_id": 0})

    await sio.emit('player_joined', {
        "game_id": game_id,
        "username": user["username"],
        "user_id": user["user_id"]
    }, room=game_id)

    await sio.emit('game_started', activated_game, room=game_id)
    await emit_watchable_count_update()

    return activated_game

@api_router.post("/games/{game_id}/join", response_model=GameResponse)
async def join_game(game_id: str, request: Request):
    user = await get_current_user(request)
    game = await db.games.find_one({"game_id": game_id}, {"_id": 0})
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")

    if game["status"] == "waiting":
        activated_game = await _activate_waiting_game(game_id, user)
        return GameResponse(**activated_game)

    if game["status"] == "active":
        if game["white_player"]["user_id"] != user["user_id"] and (
            not game.get("black_player") or game["black_player"]["user_id"] != user["user_id"]
        ):
            raise HTTPException(status_code=400, detail="Game is not available to join")
        return GameResponse(**game)

    raise HTTPException(status_code=400, detail="Game is not available to join")

# ============= MATCHMAKING (Play Active Users) =============
# Reuses the existing "waiting" game mechanism: a search either joins someone
# else's open matchmaking game (via _activate_waiting_game, same path as a
# manual /games/{id}/join) or - if nobody compatible is waiting - creates one
# and returns it, so the caller is redirected into /game/{game_id} exactly
# like a normal created game while another player's search finds it.
MATCHMAKING_QUEUE_MAX_AGE_MINUTES = 10

@api_router.post("/matchmaking/find", response_model=GameResponse)
async def find_match(request: Request, match_data: MatchmakingRequest = MatchmakingRequest()):
    user = await get_current_user(request)
    my_rating = user.get("rating", 1200)
    my_prefs = user.get("challenge_preferences") or {}
    my_allow_any = bool(my_prefs.get("allow_any_rating", True))
    my_min = my_prefs.get("min_challenge_rating")
    my_max = my_prefs.get("max_challenge_rating")

    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=MATCHMAKING_QUEUE_MAX_AGE_MINUTES)).isoformat()

    candidates = await db.games.find(
        {
            "status": "waiting",
            "matchmaking": True,
            "white_player.user_id": {"$ne": user["user_id"]},
            "created_at": {"$gte": cutoff},
        },
        {"_id": 0},
    ).sort("created_at", 1).to_list(50)

    for game in candidates:
        opponent = game.get("white_player") or {}
        opp_rating = opponent.get("rating", 1200)
        opp_allow_any = bool(game.get("matchmaking_allow_any", True))
        opp_min = game.get("matchmaking_min_rating")
        opp_max = game.get("matchmaking_max_rating")

        # The waiting player must be willing to accept my rating...
        if not opp_allow_any:
            if opp_min is not None and my_rating < int(opp_min):
                continue
            if opp_max is not None and my_rating > int(opp_max):
                continue
        # ...and I must be willing to accept theirs.
        if not my_allow_any:
            if my_min is not None and opp_rating < int(my_min):
                continue
            if my_max is not None and opp_rating > int(my_max):
                continue

        try:
            activated_game = await _activate_waiting_game(game["game_id"], user)
        except HTTPException:
            # Someone else grabbed it (or it became unavailable) between the
            # query and now - try the next candidate instead of failing out.
            continue
        return GameResponse(**activated_game)

    # No compatible opponent waiting right now: open a new matchmaking slot
    # using this player's own rating preferences, and return it so the
    # frontend can navigate straight into the game room to wait there.
    parts = match_data.time_control.split("+")
    base_time = int(parts[0]) * 60
    game_id = f"game_{uuid.uuid4().hex[:12]}"
    game_doc = {
        "game_id": game_id,
        "white_player": {
            "user_id": user["user_id"],
            "username": user["username"],
            "rating": my_rating,
            "allow_spectators": user.get("allow_spectators", True),
            "allow_chat_broadcast": user.get("allow_chat_broadcast", True),
        },
        "black_player": None,
        "time_control": match_data.time_control,
        "stake_amount": 0,
        "stake_currency": "USDT",
        "arbiter_fee": 0.02,
        "status": "waiting",
        "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        "moves": [],
        "move_times": [],
        # Phase 4e: see create_tournament_game for why these start empty.
        "fen_history": [],
        "clock_history": [],
        "white_time": base_time,
        "black_time": base_time,
        "current_turn": "white",
        "result": None,
        "winner_id": None,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "is_private": False,
        "game_type": match_data.game_type,
        "tournament_id": None,
        "matchmaking": True,
        "matchmaking_allow_any": my_allow_any,
        "matchmaking_min_rating": None if my_allow_any else my_min,
        "matchmaking_max_rating": None if my_allow_any else my_max,
    }

    await db.games.insert_one(game_doc)
    game_doc.pop("_id", None)

    await sio.emit("game_created", game_doc)
    await emit_watchable_count_update()

    return GameResponse(**game_doc)

@api_router.post("/matchmaking/cancel")
async def cancel_matchmaking(request: Request):
    """Withdraw the caller's own open matchmaking game, if it's still
    unmatched. No-ops (rather than erroring) if it already got matched or
    there wasn't one, since the frontend calls this defensively."""
    user = await get_current_user(request)
    result = await db.games.delete_one(
        {
            "white_player.user_id": user["user_id"],
            "status": "waiting",
            "matchmaking": True,
        }
    )
    return {"cancelled": result.deleted_count > 0}

# NOTE: Keep this static route before /games/{game_id} to avoid the dynamic
# game_id route capturing the literal "watchable-count" path.
@api_router.get("/games/watchable-count")
async def get_watchable_games_count():
    count = await get_watchable_match_count()
    return {"count": count}

# ============= SOCIAL STREAMING (Stream to TikTok / Instagram / Facebook / YouTube) =============
# Mirrors the /auth/google/* pattern above: use the real provider's OAuth
# authorize flow when that platform's client id/secret are configured in the
# environment, otherwise fall back to an instant local "connect" so the
# feature is fully clickable in dev/demo environments without live API keys.
#
# Each connected account is stored per-user in db.stream_accounts, keyed by
# (user_id, platform). Going live records a db.stream_sessions row and emits
# a socket event to the game room so spectators can see the match is being
# broadcast live elsewhere.

# The OAuth `redirect_uri` sent to each provider must be an exact match for
# a URI registered in that provider's app console, AND it must be a URL the
# provider will actually hand the auth code to - i.e. our own backend
# callback route (this file), never the frontend. It is therefore computed
# here from the backend's own public URL rather than trusted from the
# frontend. Set BACKEND_BASE_URL explicitly in production (e.g.
# https://your-api.onrender.com); Render also exposes RENDER_EXTERNAL_URL
# automatically. FRONTEND_BASE_URL is only used as a fallback landing page
# if the frontend doesn't tell us where to send the browser back to.
BACKEND_BASE_URL = (
    os.environ.get('BACKEND_BASE_URL')
    or os.environ.get('RENDER_EXTERNAL_URL')
    or 'http://localhost:8000'
).rstrip('/')
FRONTEND_BASE_URL = os.environ.get('FRONTEND_BASE_URL', 'http://localhost:3000').rstrip('/')


def _stream_oauth_redirect_uri(platform: str) -> str:
    """The single, stable redirect_uri registered with each provider for
    this platform. Must point at our backend callback route below."""
    return f"{BACKEND_BASE_URL}/api/stream/{platform}/callback"


def _append_query(url: str, **params: str) -> str:
    """Appends query params to a URL that may already have its own query
    string, without clobbering it."""
    separator = "&" if "?" in url else "?"
    return f"{url}{separator}{urlencode(params)}"


STREAM_OAUTH_CONFIG = {
    "tiktok": {
        "authorize_url": "https://www.tiktok.com/v2/auth/authorize",
        "token_url": "https://open.tiktokapis.com/v2/oauth/token/",
        "client_id_env": "TIKTOK_CLIENT_ID",
        "client_secret_env": "TIKTOK_CLIENT_SECRET",
        "scope": "user.info.basic,video.publish",
    },
    "instagram": {
        # NOTE: this must be www.instagram.com, not api.instagram.com.
        # api.instagram.com/oauth/authorize was the Basic Display API's
        # authorize endpoint - Meta sunset Basic Display on 2024-12-04 and it
        # no longer works for personal accounts. The current "Instagram API
        # with Instagram Login" (which the scopes below already target)
        # authorizes at www.instagram.com/oauth/authorize; only token
        # exchange stays on api.instagram.com. www.instagram.com is also the
        # domain the Instagram app claims for universal links, so fixing
        # this also lets the OS hand off to the installed app automatically
        # on iOS/Android - no extra JS needed for that part.
        "authorize_url": "https://www.instagram.com/oauth/authorize",
        "token_url": "https://api.instagram.com/oauth/access_token",
        "client_id_env": "INSTAGRAM_CLIENT_ID",
        "client_secret_env": "INSTAGRAM_CLIENT_SECRET",
        # Current Instagram API with Instagram Login (business login) scopes.
        # Requires the connecting account to be a Business or Creator account
        # - personal accounts are no longer supported by any Instagram API.
        "scope": "instagram_business_basic,instagram_business_content_publish",
    },
    "facebook": {
        "authorize_url": "https://www.facebook.com/v19.0/dialog/oauth",
        "token_url": "https://graph.facebook.com/v19.0/oauth/access_token",
        "client_id_env": "FACEBOOK_CLIENT_ID",
        "client_secret_env": "FACEBOOK_CLIENT_SECRET",
        "scope": "public_profile,pages_manage_posts,publish_video",
    },
    "youtube": {
        "authorize_url": "https://accounts.google.com/o/oauth2/v2/auth",
        "token_url": "https://oauth2.googleapis.com/token",
        "client_id_env": "YOUTUBE_CLIENT_ID",
        "client_secret_env": "YOUTUBE_CLIENT_SECRET",
        "scope": "https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.force-ssl",
    },
}


def _exchange_stream_code_for_token(platform: str, code: str, redirect_uri: str, client_id: str, client_secret: str) -> dict:
    """Platform-specific authorization-code -> access-token exchange. Each
    provider has a slightly different request shape; this normalizes the
    result to {access_token, refresh_token, expires_in}."""
    config = STREAM_OAUTH_CONFIG[platform]

    if platform == "tiktok":
        resp = requests.post(
            config["token_url"],
            headers={"Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache"},
            data={
                "client_key": client_id,
                "client_secret": client_secret,
                "code": code,
                "grant_type": "authorization_code",
                "redirect_uri": redirect_uri,
            },
            timeout=20,
        )
        resp.raise_for_status()
        data = resp.json()
        return {
            "access_token": data.get("access_token"),
            "refresh_token": data.get("refresh_token"),
            "expires_in": data.get("expires_in"),
        }

    if platform == "instagram":
        resp = requests.post(
            config["token_url"],
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "grant_type": "authorization_code",
                "redirect_uri": redirect_uri,
                "code": code,
            },
            timeout=20,
        )
        resp.raise_for_status()
        data = resp.json()
        short_lived_token = data.get("access_token")

        # Exchange the 1-hour short-lived token for a 60-day long-lived one.
        long_lived_token = short_lived_token
        expires_in = 3600
        if short_lived_token:
            try:
                exch = requests.get(
                    "https://graph.instagram.com/access_token",
                    params={
                        "grant_type": "ig_exchange_token",
                        "client_secret": client_secret,
                        "access_token": short_lived_token,
                    },
                    timeout=20,
                )
                exch.raise_for_status()
                exch_data = exch.json()
                long_lived_token = exch_data.get("access_token", short_lived_token)
                expires_in = exch_data.get("expires_in", 60 * 24 * 3600)
            except requests.RequestException as e:
                logger.warning(f"Instagram long-lived token exchange failed, keeping short-lived token: {e}")

        return {"access_token": long_lived_token, "refresh_token": None, "expires_in": expires_in}

    if platform == "facebook":
        resp = requests.get(
            config["token_url"],
            params={
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri,
                "code": code,
            },
            timeout=20,
        )
        resp.raise_for_status()
        data = resp.json()
        return {"access_token": data.get("access_token"), "refresh_token": None, "expires_in": data.get("expires_in")}

    if platform == "youtube":
        resp = requests.post(
            config["token_url"],
            data={
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
            timeout=20,
        )
        resp.raise_for_status()
        data = resp.json()
        return {
            "access_token": data.get("access_token"),
            "refresh_token": data.get("refresh_token"),
            "expires_in": data.get("expires_in"),
        }

    raise HTTPException(status_code=400, detail=f"No token exchange implemented for {platform}")


def _fetch_stream_platform_username(platform: str, access_token: str) -> Optional[str]:
    """Best-effort lookup of a display name/handle to show in the Stream
    dialog. Never raises - a failed lookup just means we show no username."""
    try:
        if platform == "tiktok":
            resp = requests.post(
                "https://open.tiktokapis.com/v2/user/info/",
                params={"fields": "display_name"},
                headers={"Authorization": f"Bearer {access_token}"},
                timeout=10,
            )
            resp.raise_for_status()
            return resp.json().get("data", {}).get("user", {}).get("display_name")

        if platform == "instagram":
            resp = requests.get(
                "https://graph.instagram.com/me",
                params={"fields": "username", "access_token": access_token},
                timeout=10,
            )
            resp.raise_for_status()
            return resp.json().get("username")

        if platform == "facebook":
            resp = requests.get(
                "https://graph.facebook.com/me",
                params={"fields": "name", "access_token": access_token},
                timeout=10,
            )
            resp.raise_for_status()
            return resp.json().get("name")

        if platform == "youtube":
            resp = requests.get(
                "https://www.googleapis.com/youtube/v3/channels",
                params={"part": "snippet", "mine": "true"},
                headers={"Authorization": f"Bearer {access_token}"},
                timeout=10,
            )
            resp.raise_for_status()
            items = resp.json().get("items", [])
            return items[0]["snippet"]["title"] if items else None
    except requests.RequestException as e:
        logger.warning(f"Could not fetch {platform} username after connect: {e}")
    return None


def _require_valid_platform(platform: str) -> str:
    platform = (platform or "").lower()
    if platform not in STREAM_PLATFORMS:
        raise HTTPException(status_code=400, detail=f"Unsupported platform. Choose one of: {', '.join(STREAM_PLATFORMS)}")
    return platform


@api_router.get("/stream/accounts", response_model=List[StreamAccountResponse])
async def get_stream_accounts(request: Request):
    """Connection status for every supported platform for the current user,
    so the Stream dialog can show 'Connected as ...' vs 'Sync your account'."""
    user = await get_current_user(request)
    existing = await db.stream_accounts.find(
        {"user_id": user["user_id"]}, {"_id": 0}
    ).to_list(len(STREAM_PLATFORMS))
    by_platform = {a["platform"]: a for a in existing}

    return [
        StreamAccountResponse(
            platform=platform,
            connected=bool(by_platform.get(platform, {}).get("connected")),
            username=by_platform.get(platform, {}).get("username"),
            connected_at=by_platform.get(platform, {}).get("connected_at"),
        )
        for platform in STREAM_PLATFORMS
    ]


@api_router.post("/stream/{platform}/connect")
async def connect_stream_account(platform: str, request: Request, body: StreamConnectRequest = StreamConnectRequest()):
    """Kick off syncing a social account. Returns an auth_url to redirect the
    user to when the real provider is configured; otherwise connects
    immediately with a local placeholder account (dev/demo fallback)."""
    platform = _require_valid_platform(platform)
    user = await get_current_user(request)
    config = STREAM_OAUTH_CONFIG[platform]
    client_id = os.environ.get(config["client_id_env"])
    client_secret = os.environ.get(config["client_secret_env"])
    # This MUST be our own backend callback route (registered verbatim with
    # the provider) - never a frontend URL, or the provider would hand the
    # auth code straight to the SPA instead of to us for token exchange.
    oauth_redirect_uri = _stream_oauth_redirect_uri(platform)
    frontend_redirect = body.frontend_redirect or f"{FRONTEND_BASE_URL}/lobby"

    if client_id and client_secret:
        state = f"{user['user_id']}:{uuid.uuid4().hex}"
        await db.stream_oauth_states.insert_one({
            "state": state,
            "user_id": user["user_id"],
            "platform": platform,
            "frontend_redirect": frontend_redirect,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
        params = {
            "client_id": client_id,
            "redirect_uri": oauth_redirect_uri,
            "response_type": "code",
            "scope": config["scope"],
            "state": state,
        }
        return {"auth_url": f"{config['authorize_url']}?{urlencode(params)}"}

    # No live credentials configured for this platform - connect immediately
    # so the flow stays fully testable end to end.
    placeholder_username = f"{user['username']}_{platform}"
    await db.stream_accounts.update_one(
        {"user_id": user["user_id"], "platform": platform},
        {"$set": {
            "user_id": user["user_id"],
            "platform": platform,
            "connected": True,
            "username": placeholder_username,
            "connected_at": datetime.now(timezone.utc).isoformat(),
        }},
        upsert=True,
    )
    return {"connected": True, "username": placeholder_username}


async def _finalize_stream_connect(user_id: str, platform: str, token_data: dict) -> dict:
    """Shared by both connect paths: the classic full-page OAuth redirect
    (stream_oauth_callback) and the Google Identity Services popup flow
    (connect_youtube_via_code). Fetches a display username, encrypts tokens
    at rest, and upserts db.stream_accounts. Returns {connected, username}
    for the caller to hand back to the frontend."""
    access_token = token_data.get("access_token")
    username = _fetch_stream_platform_username(platform, access_token) if access_token else None
    expires_in = token_data.get("expires_in")
    expires_at = (
        (datetime.now(timezone.utc) + timedelta(seconds=int(expires_in))).isoformat()
        if expires_in else None
    )

    # Tokens are encrypted at rest with STREAM_TOKEN_ENCRYPTION_KEY (Fernet) -
    # see encrypt_stream_token/decrypt_stream_token above. This collection
    # holds live credentials that can post to a user's account, so treat it
    # accordingly (never returned by /stream/accounts, decrypt only when
    # actually calling out to the platform, e.g. in go_live).
    await db.stream_accounts.update_one(
        {"user_id": user_id, "platform": platform},
        {"$set": {
            "user_id": user_id,
            "platform": platform,
            "connected": True,
            "username": username,
            "access_token": encrypt_stream_token(access_token),
            "refresh_token": encrypt_stream_token(token_data.get("refresh_token")),
            "token_expires_at": expires_at,
            "connected_at": datetime.now(timezone.utc).isoformat(),
        }},
        upsert=True,
    )
    return {"connected": True, "username": username}


@api_router.get("/stream/{platform}/callback")
async def stream_oauth_callback(platform: str, request: Request):
    """Completes the real OAuth flow for platforms with credentials
    configured. The provider redirects here with `code` and our `state`."""
    # The provider redirects the user's actual browser here (full-page
    # navigation, not an XHR from the SPA) - so every exit from this handler
    # must be an HTTP redirect back into the frontend, never a raw JSON/error
    # response, or the user lands on an unstyled API response.
    platform = _require_valid_platform(platform)
    code = request.query_params.get("code")
    state = request.query_params.get("state")
    default_landing = f"{FRONTEND_BASE_URL}/lobby"

    if not code or not state:
        return RedirectResponse(_append_query(default_landing, stream_error=platform))

    oauth_state = await db.stream_oauth_states.find_one({"state": state, "platform": platform}, {"_id": 0})
    if not oauth_state:
        return RedirectResponse(_append_query(default_landing, stream_error=platform))

    frontend_redirect = oauth_state.get("frontend_redirect") or default_landing

    config = STREAM_OAUTH_CONFIG[platform]
    client_id = os.environ.get(config["client_id_env"])
    client_secret = os.environ.get(config["client_secret_env"])
    if not client_id or not client_secret:
        await db.stream_oauth_states.delete_one({"state": state})
        return RedirectResponse(_append_query(frontend_redirect, stream_error=platform))

    try:
        # Must be the exact same redirect_uri sent in the authorize request
        # (see connect_stream_account) - providers validate it matches.
        token_data = _exchange_stream_code_for_token(
            platform, code, _stream_oauth_redirect_uri(platform), client_id, client_secret
        )
    except requests.RequestException as e:
        logger.error(f"{platform} token exchange failed: {e}")
        await db.stream_oauth_states.delete_one({"state": state})
        return RedirectResponse(_append_query(frontend_redirect, stream_error=platform))

    if not token_data.get("access_token"):
        logger.error(f"{platform} did not return an access token")
        await db.stream_oauth_states.delete_one({"state": state})
        return RedirectResponse(_append_query(frontend_redirect, stream_error=platform))

    await _finalize_stream_connect(oauth_state["user_id"], platform, token_data)
    await db.stream_oauth_states.delete_one({"state": state})

    return RedirectResponse(_append_query(frontend_redirect, stream_connected=platform))


@api_router.get("/stream/youtube/client-id")
async def get_youtube_client_id(request: Request):
    """Public (auth-required, but non-secret) lookup so the frontend can
    initialize Google Identity Services' popup code flow without embedding
    the client ID at build time. OAuth client IDs are not secrets - only
    YOUTUBE_CLIENT_SECRET is - so it's fine to hand this back as-is; the
    actual token exchange still happens server-side in
    connect_youtube_via_code below, using the secret."""
    await get_current_user(request)
    client_id = os.environ.get(STREAM_OAUTH_CONFIG["youtube"]["client_id_env"])
    if not client_id:
        raise HTTPException(status_code=503, detail="YouTube streaming is not configured")
    return {"client_id": client_id, "scope": STREAM_OAUTH_CONFIG["youtube"]["scope"]}


@api_router.post("/stream/youtube/connect-code")
async def connect_youtube_via_code(request: Request, body: StreamYoutubeCodeRequest):
    """Completes YouTube connect from the Google Identity Services popup
    flow (see StreamMenuDialog.jsx). Unlike the other platforms, this is a
    same-page XHR carrying a `code` handed to a JS callback by Google's
    popup - not a full-page redirect - so there's no `state` row in
    db.stream_oauth_states to look up and no HTTP redirect to issue; this
    returns plain JSON like the placeholder/dev-mode path in
    connect_stream_account does.
    IMPORTANT: when the authorization code comes from GIS popup mode (no
    redirect_uri was used - Google's popup relays it via postMessage), the
    token exchange's redirect_uri parameter must be the literal string
    "postmessage", not a URL. This is an undocumented-but-required Google
    quirk; using an actual URL here throws a redirect_uri_mismatch."""
    user = await get_current_user(request)
    config = STREAM_OAUTH_CONFIG["youtube"]
    client_id = os.environ.get(config["client_id_env"])
    client_secret = os.environ.get(config["client_secret_env"])
    if not client_id or not client_secret:
        raise HTTPException(status_code=503, detail="YouTube streaming is not configured")

    try:
        token_data = _exchange_stream_code_for_token(
            "youtube", body.code, "postmessage", client_id, client_secret
        )
    except requests.RequestException as e:
        logger.error(f"YouTube token exchange failed: {e}")
        raise HTTPException(status_code=400, detail="Unable to connect YouTube")

    if not token_data.get("access_token"):
        logger.error("YouTube did not return an access token")
        raise HTTPException(status_code=400, detail="Unable to connect YouTube")

    return await _finalize_stream_connect(user["user_id"], "youtube", token_data)


@api_router.post("/stream/{platform}/go-live")
async def go_live(platform: str, request: Request, body: StreamGoLiveRequest = StreamGoLiveRequest()):
    """Starts broadcasting the caller's match to the given platform. Requires
    that platform to already be connected via /stream/{platform}/connect."""
    platform = _require_valid_platform(platform)
    user = await get_current_user(request)

    account = await db.stream_accounts.find_one(
        {"user_id": user["user_id"], "platform": platform, "connected": True}, {"_id": 0}
    )
    if not account:
        raise HTTPException(status_code=400, detail=f"Connect your {platform} account first")

    # Decrypted here, right before use, rather than at rest above - wire this
    # into the platform's actual live-broadcast/RTMP-ingest call once each
    # provider's streaming API is integrated.
    access_token = decrypt_stream_token(account.get("access_token"))
    if account.get("access_token") and not access_token:
        raise HTTPException(status_code=401, detail=f"Your {platform} connection is invalid - please reconnect")

    game = None
    if body.game_id:
        game = await db.games.find_one({"game_id": body.game_id}, {"_id": 0})
        if not game:
            raise HTTPException(status_code=404, detail="Game not found")

    stream_id = f"stream_{uuid.uuid4().hex[:12]}"
    stream_doc = {
        "stream_id": stream_id,
        "user_id": user["user_id"],
        "username": user["username"],
        "platform": platform,
        "game_id": body.game_id,
        "status": "live",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "ended_at": None,
    }
    await db.stream_sessions.insert_one(stream_doc)
    stream_doc.pop("_id", None)

    if game:
        await sio.emit("stream_started", {
            "game_id": body.game_id,
            "platform": platform,
            "username": user["username"],
            "stream_id": stream_id,
        }, room=body.game_id)

    return stream_doc


@api_router.post("/stream/{platform}/end")
async def end_stream(platform: str, request: Request):
    """Stops the caller's current live stream on the given platform, if any."""
    platform = _require_valid_platform(platform)
    user = await get_current_user(request)

    session = await db.stream_sessions.find_one(
        {"user_id": user["user_id"], "platform": platform, "status": "live"}, {"_id": 0}
    )
    if not session:
        return {"ended": False}

    await db.stream_sessions.update_one(
        {"stream_id": session["stream_id"]},
        {"$set": {"status": "ended", "ended_at": datetime.now(timezone.utc).isoformat()}},
    )

    if session.get("game_id"):
        await sio.emit("stream_ended", {
            "game_id": session["game_id"],
            "platform": platform,
            "username": user["username"],
            "stream_id": session["stream_id"],
        }, room=session["game_id"])

    return {"ended": True}


@api_router.delete("/stream/{platform}")
async def disconnect_stream_account(platform: str, request: Request):
    """Unsyncs a previously connected social account."""
    platform = _require_valid_platform(platform)
    user = await get_current_user(request)
    result = await db.stream_accounts.delete_one({"user_id": user["user_id"], "platform": platform})
    return {"disconnected": result.deleted_count > 0}

# ============= STUDY / YOUTUBE PREVIEW =============

# GothamChess's official channel — resolved search results are restricted to
# this channel so a study never surfaces someone else's unrelated video.
GOTHAMCHESS_CHANNEL_ID = "UCQHX6ViZmPsWiYSFAyS0a3Q"
YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY")

@api_router.get("/youtube/resolve")
async def resolve_youtube_search(query: str):
    """Resolve a 'search_query=...' style link (as stored in studies.js) to a
    real, embeddable video ID from GothamChess's channel. Results are cached
    in Mongo indefinitely (query text -> video_id rarely needs to change) so
    repeat page loads don't re-spend YouTube Data API quota."""
    query = query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="query is required")

    cached = await db.youtube_cache.find_one({"query": query}, {"_id": 0})
    if cached:
        return {"video_id": cached["video_id"]}

    if not YOUTUBE_API_KEY:
        raise HTTPException(status_code=503, detail="YouTube API not configured")

    try:
        resp = requests.get(
            "https://www.googleapis.com/youtube/v3/search",
            params={
                "part": "snippet",
                "q": query,
                "type": "video",
                "channelId": GOTHAMCHESS_CHANNEL_ID,
                "maxResults": 1,
                "key": YOUTUBE_API_KEY,
            },
            timeout=8,
        )
        resp.raise_for_status()
        items = resp.json().get("items", [])
        if not items:
            raise HTTPException(status_code=404, detail="No matching video found on channel")

        video_id = items[0]["id"]["videoId"]
        await db.youtube_cache.update_one(
            {"query": query},
            {"$set": {
                "query": query,
                "video_id": video_id,
                "resolved_at": datetime.now(timezone.utc).isoformat()
            }},
            upsert=True
        )
        return {"video_id": video_id}
    except HTTPException:
        raise
    except requests.RequestException as e:
        logger.error(f"YouTube search resolution failed for query={query!r}: {e}")
        raise HTTPException(status_code=502, detail="YouTube search failed")

@api_router.get("/games/{game_id}", response_model=GameResponse)
async def get_game(game_id: str = FastAPIPath(..., regex=r"^game_.*$")):
    game = await db.games.find_one({"game_id": game_id}, {"_id": 0})
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    return GameResponse(**game)


@api_router.get("/games")
async def list_games(status: Optional[str] = None, game_type: Optional[str] = None):
    """List games with optional filtering.

    Query params:
    - status: comma-separated list, e.g. 'waiting' or 'waiting,active'
    - game_type: filter by game_type
    """
    query = {}
    if status:
        statuses = [s.strip() for s in status.split(",") if s.strip()]
        if len(statuses) == 1:
            query["status"] = statuses[0]
        else:
            query["status"] = {"$in": statuses}
    if game_type:
        query["game_type"] = game_type

    # Phase 4c: a currently-boosted ("featured") game sorts to the top of
    # the lobby, ahead of the normal newest-first ordering. featured_until
    # is compared as an ISO string against "now" - safe since both are
    # UTC ISO 8601, which sort lexicographically the same as chronologically.
    now_iso = datetime.now(timezone.utc).isoformat()
    pipeline = [
        {"$match": query},
        {"$addFields": {
            "_is_featured_now": {
                "$and": [
                    {"$eq": ["$featured", True]},
                    {"$gt": ["$featured_until", now_iso]},
                ]
            }
        }},
        {"$sort": {"_is_featured_now": -1, "created_at": -1}},
        {"$limit": 50},
        {"$project": {"_id": 0, "_is_featured_now": 0}},
    ]
    games = await db.games.aggregate(pipeline).to_list(50)
    return games


@api_router.post("/games/{game_id}/boost")
async def boost_game(game_id: str, request: Request):
    """Phase 4c: pay credits to feature a still-open game at the top of
    the lobby for FEATURED_GAME_MINUTES ('featured game'). Only the
    game's own creator can boost it, and only while it's still waiting
    for an opponent - once someone joins, there's no lobby listing left
    for a boost to matter in."""
    user = await get_current_user(request)
    game = await db.games.find_one({"game_id": game_id}, {"_id": 0})
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    if game.get("status") != "waiting":
        raise HTTPException(status_code=400, detail="Only open games waiting for an opponent can be boosted")

    creator_id = (game.get("white_player") or {}).get("user_id")
    if creator_id != user["user_id"]:
        raise HTTPException(status_code=403, detail="Only the game's creator can boost it")

    spend_result = await spend_credits(user["user_id"], "featured_game", reference_id=game_id)

    featured_until = (datetime.now(timezone.utc) + timedelta(minutes=FEATURED_GAME_MINUTES)).isoformat()
    await db.games.update_one(
        {"game_id": game_id},
        {"$set": {"featured": True, "featured_until": featured_until}}
    )

    try:
        await sio.emit("game_updated", {"game_id": game_id, "featured": True, "featured_until": featured_until})
    except Exception:
        logger.exception("Failed to emit game_updated for boost")

    return {"success": True, "featured_until": featured_until, "spend": spend_result}


async def _run_game_review_job(job_id: str, game_id: str, creator_user_id: str, creator_claim: dict):
    """Runs Stockfish Game Review for `game_id` in the background, off
    the request/response cycle, and writes the result onto the game
    doc's "analysis" field for GET /games/{game_id}/analysis to pick up
    (and delete the job doc once cached, same lifecycle as Board
    Editor's per-analysis job docs - see that endpoint's comments).

    Moved off a single blocking request for the same reason as Board
    Editor's /board/analyze: a full-game deep (ANALYSIS_DEPTH) review
    can run long enough on Render's shared/fractional CPU to blow past
    Render's own proxy timeout, independent of anything in this app.

    Unlike Board Editor jobs (one job = one user's one paid action),
    a Game Review job's underlying computation is SHARED - it's cached
    once per game and reused by every user who reviews that game - but
    only the user whose request actually created the job (creator_*)
    is refunded if it fails. Any other user who claimed their free/paid
    use while this job was already pending keeps their claim (same as
    the pre-existing in-process-lock behavior this replaces): since
    _claim_unlock_with_free_tier is idempotent per user+game, they can
    poll again for free and will get the analysis for free the moment
    a later attempt succeeds, with nothing further charged either way.

    Can run more than once for the same job_id if the process died
    before finishing - see _resume_orphaned_game_review_jobs. The
    refund-on-failure ledger effect is guarded by _claim_job_settlement
    so a resumed replay that fails again doesn't refund the creator
    twice; a successful write of the analysis doc is naturally safe to
    repeat (same content each time).
    """
    try:
        game = await db.games.find_one({"game_id": game_id}, {"_id": 0, "moves": 1, "initial_fen": 1})
        moves = (game or {}).get("moves", [])
        starting_fen = (game or {}).get("initial_fen") or None

        # See _stockfish_job_slots's docstring - caps how many of these
        # run concurrently across every Board Editor/Game Review job.
        async with _stockfish_job_slots:
            analysis = await asyncio.to_thread(analyze_game_with_stockfish, moves, starting_fen, ANALYSIS_DEPTH)

        if not analysis.get("engine_available"):
            logger.warning(f"Stockfish analysis failed for game {game_id}: {analysis.get('error')}")
            if creator_claim is not None and await _claim_job_settlement(db.game_review_jobs, job_id):
                await _refund_unlock_claim(
                    db.game_review_unlocks, creator_user_id, {"game_id": game_id},
                    creator_claim, "game_review", reason=analysis.get("error", "stockfish_failed"),
                )
            await db.game_review_jobs.update_one(
                {"job_id": job_id},
                {"$set": {
                    "status": "error",
                    "error": analysis.get("error", "Stockfish analysis failed"),
                    "updated_at": datetime.now(timezone.utc),
                }},
            )
            return

        analysis_doc = {
            "analysis_id": f"an_{uuid.uuid4().hex[:12]}",
            "game_id": game_id,
            "depth": analysis.get("depth", ANALYSIS_DEPTH),
            "summary": analysis.get("summary"),
            "moves": analysis.get("moves"),
            "engine_available": True,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        await db.games.update_one({"game_id": game_id}, {"$set": {"analysis": analysis_doc}})
        await db.game_review_jobs.delete_one({"job_id": job_id})
    except Exception as e:
        logger.exception(f"Exception during Game Review job for game {game_id}: {e}")
        if creator_claim is not None and await _claim_job_settlement(db.game_review_jobs, job_id):
            await _refund_unlock_claim(
                db.game_review_unlocks, creator_user_id, {"game_id": game_id},
                creator_claim, "game_review", reason=str(e),
            )
        await db.game_review_jobs.update_one(
            {"job_id": job_id},
            {"$set": {
                "status": "error",
                "error": str(e),
                "updated_at": datetime.now(timezone.utc),
            }},
        )


async def _resume_orphaned_game_review_jobs():
    """Crash-resume for Game Review jobs - the same idea as
    _resume_orphaned_board_analysis_jobs, applied to db.game_review_jobs.
    Called once from startup_tasks(), before the app starts serving
    traffic; see that function's docstring for why "pending" at this
    exact moment can only mean "orphaned by a crash", never "still
    legitimately running".
    """
    resumed = 0
    async for job in db.game_review_jobs.find({"status": "pending"}):
        job_id = job.get("job_id")
        game_id = job.get("game_id")
        creator_user_id = job.get("creator_user_id")
        creator_claim = job.get("creator_claim")

        if not job_id or not game_id:
            # Malformed/pre-existing doc with nothing safe to resume -
            # drop it rather than leave it stuck; the next request for
            # this game (if any) will just create a fresh job normally.
            if job_id:
                await db.game_review_jobs.delete_one({"job_id": job_id})
            continue

        asyncio.create_task(
            _run_game_review_job(job_id, game_id, creator_user_id, creator_claim)
        )
        resumed += 1

    if resumed:
        logger.info(f"Resumed {resumed} Game Review job(s) orphaned by a restart")


@api_router.post("/games/{game_id}/analysis")
async def analyze_game(game_id: str, request: Request):
    """Runs Game Review synchronously and returns the result directly.
    Deep analysis (see ANALYSIS_DEPTH) for a completed game, gated by
    the game_review 5-free-then-30-credit allowance.

    Not called by the current frontend (which uses GET
    /games/{game_id}/analysis's job-based flow below - see
    _run_game_review_job) and left as-is for any other caller that
    still expects a single blocking request/response. Because it's
    synchronous, it does NOT go through db.game_review_jobs - no
    crash-resume, and a long-running review here is still subject to
    whatever request timeout sits in front of this app.
    """
    user = await get_current_user(request)
    game = await db.games.find_one({"game_id": game_id}, {"_id": 0})
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")

    moves = game.get("moves", [])
    if not moves:
        raise HTTPException(status_code=400, detail="Game has no moves to analyze")

    # Only allow analysis for completed games or participants
    if game.get("status") != "completed":
        raise HTTPException(status_code=403, detail="Analysis is only available for completed games")

    # Check if Stockfish is available before attempting analysis (and
    # before charging anything - a user shouldn't pay for an unlock that
    # can't actually produce a review).
    if not STOCKFISH_AVAILABLE:
        logger.warning(f"Stockfish not available for analysis of game {game_id}")
        analysis_doc = {
            "analysis_id": f"an_{uuid.uuid4().hex[:12]}",
            "game_id": game_id,
            "depth": 0,
            "summary": {"best": 0, "brilliant": 0, "inaccuracy": 0, "mistake": 0, "blunder": 0},
            "moves": [],
            "engine_available": False,
            "error": "Stockfish engine not available - install stockfish for game analysis",
            "created_at": datetime.now(timezone.utc).isoformat()
        }
        await db.games.update_one({"game_id": game_id}, {"$set": {"analysis": analysis_doc}})
        return {"success": False, "analysis": analysis_doc, "engine_available": False}

    # Game Review's own 5-free-then-30-credit allowance (feature key
    # "game_review"), separate from the Board Editor's "board_analysis"
    # allowance - see _claim_unlock_with_free_tier's docstring. The
    # underlying Stockfish result is cached/shared on the game doc below,
    # but each reviewing user's free/paid slot is claimed once via this
    # helper, same "claim before charge" race-safety as the old
    # _claim_unlock. Raises HTTPException(402) if the user is past their
    # free reviews and doesn't have enough credits.
    claim = await _claim_unlock_with_free_tier(
        db.game_review_unlocks, user["user_id"], {"game_id": game_id},
        "game_review", GAME_REVIEW_FREE_LIMIT, "game_review", reference_id=game_id,
    )

    starting_fen = game.get("initial_fen") if game.get("initial_fen") else None

    # Run the blocking Stockfish analysis in a worker thread so it never freezes the
    # event loop, and take a per-game lock so concurrent requests for the same game
    # don't launch duplicate Stockfish runs on top of each other.
    lock = _get_analysis_lock(game_id)
    async with lock:
        # Re-check: another request may have just finished analyzing this game while we waited
        fresh_game = await db.games.find_one({"game_id": game_id}, {"_id": 0, "analysis": 1})
        if fresh_game and fresh_game.get("analysis"):
            return {"success": True, "analysis": fresh_game["analysis"]}

        # Game Review now always runs at deep depth (formerly the separate,
        # extra-cost "Deep Analysis" feature) - see ANALYSIS_DEPTH's docstring.
        # Shares the same concurrency cap as the job-based path below -
        # see _stockfish_job_slots's docstring.
        async with _stockfish_job_slots:
            analysis = await asyncio.to_thread(analyze_game_with_stockfish, moves, starting_fen, ANALYSIS_DEPTH)

    if not analysis.get("engine_available"):
        logger.warning(f"Stockfish analysis failed for game {game_id}: {analysis.get('error')}")
        # The unlock was claimed (and, if past the free tier, credits were
        # charged) before we knew Stockfish would actually produce a
        # result. Since it didn't, undo the claim and refund any spend so
        # the user isn't left paying for a review they never got, and can
        # simply retry (this is the bug the old /deep-analysis endpoint
        # had: it charged credits up front and never refunded on failure).
        await _refund_unlock_claim(
            db.game_review_unlocks, user["user_id"], {"game_id": game_id},
            claim, "game_review", reason=analysis.get("error", "stockfish_failed"),
        )
        analysis_doc = {
            "analysis_id": f"an_{uuid.uuid4().hex[:12]}",
            "game_id": game_id,
            "depth": 0,
            "summary": {"best": 0, "brilliant": 0, "inaccuracy": 0, "mistake": 0, "blunder": 0},
            "moves": [],
            "engine_available": False,
            "error": analysis.get("error", "Stockfish analysis failed"),
            "created_at": datetime.now(timezone.utc).isoformat()
        }
        # Deliberately NOT persisted to the game doc (unlike the old
        # behavior) - caching a failure here would make every future
        # request see engine_available: False forever instead of retrying,
        # even though the claim/charge has just been rolled back.
        return {"success": False, "analysis": analysis_doc, "engine_available": False}

    analysis_doc = {
        "analysis_id": f"an_{uuid.uuid4().hex[:12]}",
        "game_id": game_id,
        "depth": analysis.get("depth", ANALYSIS_DEPTH),
        "summary": analysis.get("summary"),
        "moves": analysis.get("moves"),
        "engine_available": True,
        "created_at": datetime.now(timezone.utc).isoformat()
    }

    # Persist analysis on the game document for quick retrieval
    await db.games.update_one({"game_id": game_id}, {"$set": {"analysis": analysis_doc}})

    return {"success": True, "analysis": analysis_doc, "paid": claim["paid"], "already_unlocked": claim["already_unlocked"]}


@api_router.get("/games/{game_id}/analysis")
async def get_game_analysis(game_id: str, request: Request):
    """Retrieve stored analysis for a game. If none exists, kick off (or
    join) a background Game Review job and tell the frontend to keep
    polling this same endpoint - see _run_game_review_job's docstring
    for why this moved off a single blocking request/response, same
    reasoning as Board Editor's /board/analyze."""
    user = await get_current_user(request)
    game = await db.games.find_one({"game_id": game_id}, {"_id": 0})
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")

    analysis = game.get("analysis")
    if game.get("status") != "completed":
        raise HTTPException(status_code=403, detail="Analysis is only available for completed games")

    # Fallback: run analysis if game has moves and the game is completed
    moves = game.get("moves", [])

    if not analysis and not moves:
        raise HTTPException(status_code=400, detail="No moves to analyze")

    # Check if Stockfish is available before attempting analysis. Checked
    # before the paid unlock below so a user isn't charged for a review
    # the engine can't actually produce - but if analysis is already
    # cached, Stockfish availability is moot, so this only applies to the
    # not-yet-computed path.
    if not analysis and not STOCKFISH_AVAILABLE:
        logger.warning(f"Stockfish not available for analysis of game {game_id}")
        # Return a cached empty analysis instead of 503
        return {
            "analysis": {
                "analysis_id": f"an_{uuid.uuid4().hex[:12]}",
                "game_id": game_id,
                "depth": 0,
                "summary": {"best": 0, "brilliant": 0, "inaccuracy": 0, "mistake": 0, "blunder": 0},
                "moves": [],
                "engine_available": False,
                "error": "Stockfish engine not available - install stockfish for game analysis",
                "created_at": datetime.now(timezone.utc).isoformat()
            }
        }

    # Game Review's 5-free-then-30-credit allowance (feature key
    # "game_review"). Applies whether analysis is already cached or still
    # needs computing - see _claim_unlock_with_free_tier's docstring.
    # Raises HTTPException(402) if the user is past their free reviews and
    # doesn't have enough credits. Idempotent per user+game (the
    # underlying claim doc is only ever inserted once), so calling this
    # again on every poll - including polls that just join an
    # already-running job - never double-charges the same user.
    claim = await _claim_unlock_with_free_tier(
        db.game_review_unlocks, user["user_id"], {"game_id": game_id},
        "game_review", GAME_REVIEW_FREE_LIMIT, "game_review", reference_id=game_id,
    )

    if analysis:
        return {"analysis": analysis}

    # No cached result yet. db.game_review_jobs is keyed uniquely on
    # game_id - the Stockfish computation is shared/cached across every
    # user reviewing this game, so at most one job (and one Stockfish
    # run) should ever be in flight for it at a time, no matter how many
    # users are simultaneously polling for it.
    existing_job = await db.game_review_jobs.find_one({"game_id": game_id}, {"_id": 0})
    if existing_job:
        if existing_job["status"] == "error":
            # Deliver the error once, then clear the job doc so the next
            # request - automatic retry or the user's Refresh button -
            # starts a fresh job instead of seeing the same stale error
            # forever. Not persisted to the game doc, same as before, so
            # a retry actually retries.
            await db.game_review_jobs.delete_one({"game_id": game_id})
            return {
                "analysis": {
                    "analysis_id": f"an_{uuid.uuid4().hex[:12]}",
                    "game_id": game_id,
                    "depth": 0,
                    "summary": {"best": 0, "brilliant": 0, "inaccuracy": 0, "mistake": 0, "blunder": 0},
                    "moves": [],
                    "engine_available": False,
                    "error": existing_job.get("error", "Stockfish analysis failed"),
                    "created_at": datetime.now(timezone.utc).isoformat(),
                }
            }
        # status "pending" - already running (by this process, another
        # worker, or resumed after a restart). Nothing to do but tell the
        # frontend to keep polling.
        return {"status": "pending"}

    job_id = f"gr_{game_id}"
    try:
        await db.game_review_jobs.insert_one({
            "job_id": job_id,
            "game_id": game_id,
            "status": "pending",
            # The claim/refund pair for a Game Review failure is only
            # ever applied to whichever user's request actually created
            # the job - see _run_game_review_job's docstring for why
            # that mirrors this endpoint's pre-existing behavior rather
            # than refunding every user who happened to be polling.
            "creator_user_id": user["user_id"],
            "creator_claim": claim,
            "settled": False,
            "error": None,
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
        })
    except DuplicateKeyError:
        # Lost the race to a concurrent request for this exact game -
        # that request's job is the one running now; just poll it.
        return {"status": "pending"}

    asyncio.create_task(_run_game_review_job(job_id, game_id, user["user_id"], claim))
    return {"status": "pending"}

@api_router.post("/games/{game_id}/move")
async def make_move(game_id: str, move_data: MoveRequest, request: Request):
    user = await get_current_user(request)
    
    game = await db.games.find_one({"game_id": game_id}, {"_id": 0})
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    
    if game["status"] != "active":
        raise HTTPException(status_code=400, detail="Game is not active")
    
    current_player = game["white_player"] if game["current_turn"] == "white" else game["black_player"]
    if current_player["user_id"] != user["user_id"]:
        raise HTTPException(status_code=400, detail="Not your turn")
    
    next_turn = "black" if game["current_turn"] == "white" else "white"
    
    # Record move time for anti-cheat
    move_time = move_data.move_time if move_data.move_time else 0

    # Phase 4e: snapshot the board/clock as they stood immediately BEFORE
    # this move, so a takeback_token can pop straight back to it later.
    # Pushed every move regardless of whether takeback ever gets used on
    # this particular game - cheap to store, and the alternative (trying
    # to reconstruct history from `moves` after the fact) would require
    # replaying the whole game through a chess engine at takeback time.
    pre_move_fen = game["fen"]
    pre_move_clock = {"white_time": game.get("white_time"), "black_time": game.get("black_time")}

    await db.games.update_one(
        {"game_id": game_id},
        {
            "$set": {
                "fen": move_data.fen,
                "current_turn": next_turn,
                **({"white_time": move_data.white_time, "black_time": move_data.black_time} if (move_data.white_time is not None or move_data.black_time is not None) else {})
            },
            "$push": {
                "moves": move_data.move,
                "move_times": move_time,
                "fen_history": pre_move_fen,
                "clock_history": pre_move_clock
            }
        }
    )
    
    game = await db.games.find_one({"game_id": game_id}, {"_id": 0})
    
    # Compute explicit room name used for emits
    room_name = str(game_id)
    room_clients = game_connections.get(room_name, set())
    # include persisted times if present
    payload = {
        "game_id": game_id,
        "move": move_data.move,
        "fen": move_data.fen,
        "current_turn": next_turn,
        "white_time": game.get("white_time"),
        "black_time": game.get("black_time"),
    }
    logger.info(f"🎯 About to emit move_made to room '{room_name}': payload={payload}, clients_in_room={len(room_clients)}")
    print(f"[PRINT] 🎯 About to emit move_made to room '{room_name}': payload={payload}, clients_in_room={len(room_clients)}")
    
    await sio.emit('move_made', payload, room=room_name)
    
    logger.info(f"✅ Emitted move_made to room '{room_name}'")
    print(f"[PRINT] ✅ Emitted move_made to room '{room_name}'")
    
    return {"success": True, "game": GameResponse(**game)}

@api_router.post("/games/{game_id}/end")
async def end_game(game_id: str, request: Request):
    body = await request.json()
    result = body.get("result")
    reason = body.get("reason", "checkmate")
    
    user = await get_current_user(request)
    
    game = await db.games.find_one({"game_id": game_id}, {"_id": 0})
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    
    if game["status"] != "active":
        raise HTTPException(status_code=400, detail="Game is not active")
    
    player_ids = [game["white_player"]["user_id"], game["black_player"]["user_id"]]
    if user["user_id"] not in player_ids:
        raise HTTPException(status_code=403, detail="Not a player in this game")
    
    winner_id = None
    loser_id = None
    
    if result == "white":
        winner_id = game["white_player"]["user_id"]
        loser_id = game["black_player"]["user_id"]
    elif result == "black":
        winner_id = game["black_player"]["user_id"]
        loser_id = game["white_player"]["user_id"]
    
    await db.games.update_one(
        {"game_id": game_id},
        {
            "$set": {
                "status": "completed",
                "result": result,
                "winner_id": winner_id,
                "end_reason": reason,
                "ended_at": datetime.now(timezone.utc).isoformat()
            }
        }
    )

    # Update tournament leaderboard if this was a tournament match.
    # `game` was fetched before the update above and still has the old
    # (pre-result) fields, so patch in what we just wrote before passing
    # it along — otherwise the leaderboard update silently no-ops every time.
    game["result"] = result
    game["winner_id"] = winner_id
    await update_tournament_leaderboard_for_game(game)
    
    # Handle stake distribution
    if game["stake_amount"] > 0:
        total_pot = game["stake_amount"] * 2
        arbiter_fee = total_pot * game["arbiter_fee"]
        winner_amount = total_pot - arbiter_fee
        
        if winner_id:
            await db.users.update_one(
                {"user_id": winner_id},
                {"$inc": {f"wallet_balance.{game['stake_currency']}": winner_amount}}
            )
            
            await db.transactions.insert_one({
                "tx_id": f"tx_{uuid.uuid4().hex[:12]}",
                "user_id": winner_id,
                "tx_type": "win",
                "amount": winner_amount,
                "currency": game["stake_currency"],
                "status": "completed",
                "created_at": datetime.now(timezone.utc).isoformat(),
                "related_game_id": game_id
            })
            
            await db.platform_revenue.insert_one({
                "tx_id": f"tx_{uuid.uuid4().hex[:12]}",
                "amount": arbiter_fee,
                "currency": game["stake_currency"],
                "game_id": game_id,
                "created_at": datetime.now(timezone.utc).isoformat()
            })
        else:
            for player_id in player_ids:
                await db.users.update_one(
                    {"user_id": player_id},
                    {"$inc": {f"wallet_balance.{game['stake_currency']}": game["stake_amount"]}}
                )
    
    # Update ELO ratings
    if winner_id and loser_id:
        winner = await db.users.find_one({"user_id": winner_id}, {"_id": 0})
        loser = await db.users.find_one({"user_id": loser_id}, {"_id": 0})
        
        winner_change, loser_change = calculate_elo_change(
            winner.get("rating", 1200),
            loser.get("rating", 1200)
        )
        
        await db.users.update_one(
            {"user_id": winner_id},
            {"$inc": {"rating": winner_change, "games_played": 1, "wins": 1}}
        )
        
        await db.users.update_one(
            {"user_id": loser_id},
            {"$inc": {"rating": loser_change, "games_played": 1, "losses": 1}}
        )
        
        # Anti-cheat analysis after game
        analysis = await analyze_player_behavior(winner_id)
        if analysis["flagged"]:
            await flag_suspicious_player(winner_id, analysis["reasons"])
    elif result == "draw":
        for player_id in player_ids:
            await db.users.update_one(
                {"user_id": player_id},
                {"$inc": {"games_played": 1, "draws": 1}}
            )
    
    await sio.emit('game_ended', {
        "game_id": game_id,
        "result": result,
        "winner_id": winner_id,
        "reason": reason,
        "tournament_id": game.get("tournament_id")
    }, room=game_id)
    await emit_watchable_count_update()
    
    return {"success": True}


@api_router.post("/games/{game_id}/draw/offer")
async def offer_draw(game_id: str, request: Request):
    user = await get_current_user(request)
    game = await db.games.find_one({"game_id": game_id}, {"_id": 0})
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    if game["status"] != "active":
        raise HTTPException(status_code=400, detail="Game is not active")

    # store draw offer in game doc
    await db.games.update_one({"game_id": game_id}, {"$set": {"draw_offer": user["user_id"]}})
    await sio.emit('draw_offered', {"game_id": game_id, "from": user["user_id"]}, room=game_id)
    return {"success": True}


@api_router.post("/games/{game_id}/draw/accept")
async def accept_draw(game_id: str, request: Request):
    user = await get_current_user(request)
    game = await db.games.find_one({"game_id": game_id}, {"_id": 0})
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    if game.get("draw_offer") is None:
        raise HTTPException(status_code=400, detail="No draw offer to accept")

    # End game as draw
    await db.games.update_one({"game_id": game_id}, {"$set": {"status": "completed", "result": "draw", "end_reason": "draw_agreed", "ended_at": datetime.now(timezone.utc).isoformat()}})
    await sio.emit('draw_declared', {"game_id": game_id, "by": user["user_id"]}, room=game_id)

    # Free up tournament players and trigger the next round of arena pairing
    game["result"] = "draw"
    await update_tournament_leaderboard_for_game(game)

    return {"success": True}


@api_router.post("/games/{game_id}/draw/cancel")
async def cancel_draw_offer(game_id: str, request: Request):
    user = await get_current_user(request)
    game = await db.games.find_one({"game_id": game_id}, {"_id": 0})
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    if game.get("draw_offer") != user["user_id"]:
        raise HTTPException(status_code=403, detail="Only offerer can cancel the draw offer")

    await db.games.update_one({"game_id": game_id}, {"$unset": {"draw_offer": ""}})
    await sio.emit('draw_cancelled', {"game_id": game_id, "by": user["user_id"]}, room=game_id)
    return {"success": True}

@api_router.post("/games/{game_id}/resign")
async def resign_game(game_id: str, request: Request):
    user = await get_current_user(request)
    
    game = await db.games.find_one({"game_id": game_id}, {"_id": 0})
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    
    if game["white_player"]["user_id"] == user["user_id"]:
        result = "black"
    elif game["black_player"]["user_id"] == user["user_id"]:
        result = "white"
    else:
        raise HTTPException(status_code=403, detail="Not a player in this game")
    
    # Create a new mock request with the result data
    class MockRequest:
        def __init__(self, original_request, body_data):
            self.cookies = original_request.cookies
            self.headers = original_request.headers
            self._body_data = body_data
        
        async def json(self):
            return self._body_data
    
    mock_req = MockRequest(request, {"result": result, "reason": "resignation"})
    return await end_game(game_id, mock_req)

@api_router.post("/games/{game_id}/abandon")
async def abandon_game(game_id: str, request: Request):
    """Handle game abandonment with penalties"""
    user = await get_current_user(request)
    
    game = await db.games.find_one({"game_id": game_id}, {"_id": 0})
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    
    if game["status"] != "active":
        raise HTTPException(status_code=400, detail="Game is not active")
    
    # Apply abandonment penalty
    await apply_abandonment_penalty(
        user["user_id"],
        game_id,
        game["stake_amount"],
        game["stake_currency"]
    )
    
    # End the game
    if game["white_player"]["user_id"] == user["user_id"]:
        result = "black"
    else:
        result = "white"
    
    await db.games.update_one(
        {"game_id": game_id},
        {
            "$set": {
                "status": "completed",
                "result": result,
                "end_reason": "abandonment",
                "ended_at": datetime.now(timezone.utc).isoformat()
            }
        }
    )
    
    # Emit game_ended event for real-time update
    await sio.emit('game_ended', {
        "game_id": game_id,
        "result": result,
        "reason": "abandonment",
        "tournament_id": game.get("tournament_id")
    }, room=game_id)

    # Free up tournament players and trigger the next round of arena pairing
    game["result"] = result
    await update_tournament_leaderboard_for_game(game)

    return {"success": True}


@api_router.post("/games/{game_id}/rematch")
async def request_rematch(game_id: str, request: Request):
    """Phase 4c: spend a 'rematch token' to instantly re-challenge your
    opponent from a just-finished CASUAL game. Staked games are
    structurally excluded here (stake_amount == 0 required) - a rematch
    token can never become a way to re-enter a staked game without going
    through the normal create-game/stake flow and its wallet checks.

    Rather than force the opponent into a new game unilaterally, this
    creates a fresh waiting game and sends it through the existing
    challenge/accept flow - the opponent still has to accept, same as any
    other challenge."""
    user = await get_current_user(request)
    game = await db.games.find_one({"game_id": game_id}, {"_id": 0})
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    if game.get("status") != "completed":
        raise HTTPException(status_code=400, detail="Rematch is only available once the game has ended")
    if game.get("stake_amount", 0) > 0:
        raise HTTPException(status_code=400, detail="Rematch tokens can only be used for casual (non-staked) games")

    white = game.get("white_player") or {}
    black = game.get("black_player") or {}
    if user["user_id"] == white.get("user_id"):
        opponent_id = black.get("user_id")
    elif user["user_id"] == black.get("user_id"):
        opponent_id = white.get("user_id")
    else:
        raise HTTPException(status_code=403, detail="You did not play in this game")
    if not opponent_id:
        raise HTTPException(status_code=400, detail="Original opponent is unavailable for a rematch")

    _enforce_game_creation_rate_limit(user["user_id"])

    spend_result = await spend_credits(user["user_id"], "rematch_token", reference_id=game_id)

    parts = game["time_control"].split("+")
    base_time = int(parts[0]) * 60
    new_game_id = f"game_{uuid.uuid4().hex[:12]}"
    new_game_doc = {
        "game_id": new_game_id,
        "white_player": {
            "user_id": user["user_id"],
            "username": user["username"],
            "rating": user.get("rating", 1200),
            "allow_spectators": user.get("allow_spectators", True),
            "allow_chat_broadcast": user.get("allow_chat_broadcast", True),
        },
        "black_player": None,
        "time_control": game["time_control"],
        "stake_amount": 0,
        "stake_currency": game.get("stake_currency", "USDT"),
        "arbiter_fee": 0.02,
        "status": "waiting",
        "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        "moves": [],
        "move_times": [],
        # Phase 4e: see create_tournament_game for why these start empty.
        "fen_history": [],
        "clock_history": [],
        "white_time": base_time,
        "black_time": base_time,
        "current_turn": "white",
        "result": None,
        "winner_id": None,
        "created_at": datetime.now(timezone.utc).isoformat(),
        # Private: this game is only meant for the two rematching
        # players, not the public lobby/matchmaking pool.
        "is_private": True,
        "game_type": game.get("game_type", "rapid"),
        "tournament_id": None,
        "featured": False,
        "featured_until": None,
    }

    try:
        await db.games.insert_one(dict(new_game_doc))
    except Exception:
        await grant_credits(
            user["user_id"], spend_result["cost"], "refund",
            reference_id=spend_result.get("tx_id"),
            metadata={"reason": "rematch_game_create_failed"},
        )
        raise

    challenge_id = f"challenge_{uuid.uuid4().hex[:12]}"
    challenge_doc = {
        "challenge_id": challenge_id,
        "from_user_id": user["user_id"],
        "to_user_id": opponent_id,
        "game_id": new_game_id,
        "message": "Rematch!",
        "status": "pending",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.challenges.insert_one(challenge_doc)

    try:
        await sio.emit('challenge_received', {
            "challenge_id": challenge_id,
            "from_user_id": user["user_id"],
            "from_username": user.get("username"),
            "game_id": new_game_id,
            "message": "Rematch!"
        }, room=f"user_{opponent_id}")
    except Exception:
        logger.exception("Failed to emit challenge_received for rematch")

    return {"success": True, "game_id": new_game_id, "challenge_id": challenge_id, "spend": spend_result}


@api_router.post("/challenges")
async def create_challenge(request: Request):
    user = await get_current_user(request)
    body = await request.json()
    target_user_id = body.get("target_user_id")
    game_id = body.get("game_id")
    message = body.get("message")

    if not target_user_id:
        raise HTTPException(status_code=400, detail="target_user_id required")

    # Enforce recipient's challenge preferences (if any)
    target_user = await db.users.find_one({"user_id": target_user_id}, {"_id": 0})
    if not target_user:
        raise HTTPException(status_code=404, detail="Target user not found")

    prefs = target_user.get("challenge_preferences") or {}
    allow_any = bool(prefs.get("allow_any_rating", False))
    min_rating = prefs.get("min_challenge_rating")
    max_rating = prefs.get("max_challenge_rating")

    challenger_rating = user.get("rating", 1200)

    if not allow_any:
        if min_rating is not None and challenger_rating < int(min_rating):
            raise HTTPException(status_code=403, detail=f"User does not accept challenges from players below rating {min_rating}")
        if max_rating is not None and challenger_rating > int(max_rating):
            raise HTTPException(status_code=403, detail=f"User does not accept challenges from players above rating {max_rating}")

    challenge_id = f"challenge_{uuid.uuid4().hex[:12]}"

    # Phase 4c: free challenge invites up to CHALLENGE_FREE_DAILY_INVITES
    # per day, then charged in credits. Checked before the challenge is
    # created so a 402 here never creates a dangling challenge doc; usage
    # is only recorded after the insert actually succeeds.
    budget_result = await _consume_daily_budget(
        user, "challenges_sent", CHALLENGE_FREE_DAILY_INVITES, "challenge_invite_extra",
        reference_id=challenge_id, collection=db.social_daily_usage,
    )

    challenge_doc = {
        "challenge_id": challenge_id,
        "from_user_id": user["user_id"],
        "to_user_id": target_user_id,
        "game_id": game_id,
        "message": message,
        "status": "pending",
        "created_at": datetime.now(timezone.utc).isoformat()
    }

    # If this invite was paid (past the free daily limit), refund on
    # insert failure rather than leave the user billed for a challenge
    # that doesn't exist - same pattern as rematch/private-tournament.
    try:
        await db.challenges.insert_one(challenge_doc)
    except Exception:
        if budget_result.get("paid"):
            spend = budget_result["spend"]
            await grant_credits(
                user["user_id"], spend["cost"], "refund",
                reference_id=spend.get("tx_id"),
                metadata={"reason": "challenge_create_failed"},
            )
        raise

    await _record_daily_usage(user, "challenges_sent", collection=db.social_daily_usage)

    # Notify target user via their personal room
    try:
        await sio.emit('challenge_received', {
            "challenge_id": challenge_id,
            "from_user_id": user["user_id"],
            "from_username": user.get("username"),
            "game_id": game_id,
            "message": message
        }, room=f"user_{target_user_id}")
    except Exception:
        logger.exception("Failed to emit challenge_received")

    return {"success": True, "challenge_id": challenge_id, "credits_charged": budget_result["paid"]}


@api_router.get("/challenges/invite-status")
async def get_challenge_invite_status(request: Request):
    """Phase 5: read-only preview of today's free challenge-invite budget
    and what the next one beyond it would cost, so the frontend can show
    'X free invites left today' near wherever a challenge gets sent (e.g.
    Leaderboard's per-row challenge button) instead of the price only
    surfacing after a 402. Never charges or increments."""
    user = await get_current_user(request)
    today = _today_str_for_timezone(user.get("timezone"))
    progress = await db.social_daily_usage.find_one({"user_id": user["user_id"]}, {"_id": 0}) or {}
    used_today = progress.get("challenges_sent_today", 0) if progress.get("challenges_sent_date") == today else 0
    cost = await get_credit_feature_cost("challenge_invite_extra")
    return {
        "used_today": used_today,
        "free_limit": CHALLENGE_FREE_DAILY_INVITES,
        "remaining_free": max(0, CHALLENGE_FREE_DAILY_INVITES - used_today),
        "cost": cost,
    }


@api_router.get("/challenges/pending")
async def get_pending_challenges(request: Request):
    user = await get_current_user(request)
    pending = await db.challenges.find(
        {"to_user_id": user["user_id"], "status": "pending"},
        {"_id": 0}
    ).to_list(100)
    sender_ids = list({c["from_user_id"] for c in pending})
    senders = await db.users.find({"user_id": {"$in": sender_ids}}, {"_id": 0, "user_id": 1, "username": 1}).to_list(len(sender_ids))
    sender_map = {sender["user_id"]: sender.get("username", "Opponent") for sender in senders}
    for challenge in pending:
        challenge["from_username"] = sender_map.get(challenge["from_user_id"], "Opponent")
    return {"challenges": pending}


@api_router.post("/challenges/{challenge_id}/accept")
async def accept_challenge(challenge_id: str, request: Request):
    user = await get_current_user(request)
    challenge = await db.challenges.find_one({"challenge_id": challenge_id}, {"_id": 0})
    if not challenge:
        raise HTTPException(status_code=404, detail="Challenge not found")
    if challenge["to_user_id"] != user["user_id"]:
        raise HTTPException(status_code=403, detail="Cannot accept someone else's challenge")
    if challenge["status"] != "pending":
        raise HTTPException(status_code=400, detail="Challenge is no longer pending")

    await db.challenges.update_one(
        {"challenge_id": challenge_id},
        {
            "$set": {
                "status": "accepted",
                "resolved_at": datetime.now(timezone.utc).isoformat()
            }
        }
    )

    activated_game = None
    if challenge.get("game_id"):
        try:
            activated_game = await _activate_waiting_game(challenge["game_id"], user)
        except Exception as exc:
            logger.exception("Failed to activate waiting game on challenge accept")
            raise HTTPException(status_code=500, detail="Unable to start accepted challenge") from exc

    # Notify challenger that their challenge was accepted
    try:
        await sio.emit('challenge_accepted', {
            "challenge_id": challenge_id,
            "game_id": challenge.get("game_id"),
            "to_user_id": challenge.get("to_user_id"),
            "to_username": user.get("username")
        }, room=f"user_{challenge.get('from_user_id')}")
    except Exception:
        logger.exception("Failed to emit challenge_accepted")

    response = {"success": True, "game_id": challenge.get("game_id")}
    if activated_game is not None:
        response["game"] = activated_game
    return response


@api_router.post("/challenges/{challenge_id}/reject")
async def reject_challenge(challenge_id: str, request: Request):
    user = await get_current_user(request)
    challenge = await db.challenges.find_one({"challenge_id": challenge_id}, {"_id": 0})
    if not challenge:
        raise HTTPException(status_code=404, detail="Challenge not found")
    if challenge["to_user_id"] != user["user_id"]:
        raise HTTPException(status_code=403, detail="Cannot reject someone else's challenge")
    if challenge["status"] != "pending":
        raise HTTPException(status_code=400, detail="Challenge is no longer pending")

    await db.challenges.update_one(
        {"challenge_id": challenge_id},
        {
            "$set": {
                "status": "rejected",
                "resolved_at": datetime.now(timezone.utc).isoformat()
            }
        }
    )

    try:
        await sio.emit('challenge_rejected', {
            "challenge_id": challenge_id,
            "to_user_id": challenge.get("to_user_id"),
            "to_username": user.get("username")
        }, room=f"user_{challenge.get('from_user_id')}")
    except Exception:
        logger.exception("Failed to emit challenge_rejected")

    return {"success": True}


@api_router.post("/messages")
async def send_direct_message(request: Request):
    user = await get_current_user(request)
    body = await request.json()
    to_user = body.get("to_user_id")
    message = body.get("message")

    if not to_user or not message:
        raise HTTPException(status_code=400, detail="to_user_id and message required")

    msg_doc = {
        "from_user_id": user["user_id"],
        "to_user_id": to_user,
        "message": message,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }

    try:
        res = await db.direct_messages.insert_one(msg_doc)
        # Prepare JSON-serializable emit document
        emit_doc = {
            "id": str(res.inserted_id),
            "from_user_id": msg_doc["from_user_id"],
            "to_user_id": msg_doc["to_user_id"],
            "message": msg_doc["message"],
            "timestamp": msg_doc["timestamp"]
        }

        emit_doc["from_username"] = user.get("username")
        await sio.emit('direct_message', emit_doc, room=f"user_{to_user}")
        await sio.emit('direct_message', emit_doc, room=f"user_{user['user_id']}")

        return {"success": True, "message": emit_doc}
    except Exception as e:
        logger.exception("Failed to send direct message")
        raise HTTPException(status_code=500, detail="Failed to send message")


@api_router.get("/conversations")
async def list_conversations(request: Request):
    user = await get_current_user(request)

    pipeline = [
        {"$match": {"$or": [{"from_user_id": user["user_id"]}, {"to_user_id": user["user_id"]}]}},
        {"$sort": {"timestamp": -1}},
        {"$group": {
            "_id": {
                "$cond": [
                    {"$eq": ["$from_user_id", user["user_id"]]},
                    "$to_user_id",
                    "$from_user_id"
                ]
            },
            "last_message": {"$first": "$message"},
            "last_timestamp": {"$first": "$timestamp"},
            "from_user_id": {"$first": "$from_user_id"},
            "to_user_id": {"$first": "$to_user_id"}
        }},
        {"$sort": {"last_timestamp": -1}}
    ]

    raw = await db.direct_messages.aggregate(pipeline).to_list(1000)
    conversations = []
    for item in raw:
        other_id = item["_id"]
        other_user = await db.users.find_one({"user_id": other_id}, {"_id": 0, "username": 1})
        conversations.append({
            "user_id": other_id,
            "username": other_user.get("username", "Unknown") if other_user else "Unknown",
            "last_message": item.get("last_message"),
            "last_timestamp": item.get("last_timestamp"),
            "unread": 0
        })

    return {"conversations": conversations}

@api_router.get("/conversations/{other_user_id}")
async def get_conversation(other_user_id: str, request: Request):
    user = await get_current_user(request)
    # Fetch direct messages between the two users
    conv = await db.direct_messages.find({
        "$or": [
            {"from_user_id": user["user_id"], "to_user_id": other_user_id},
            {"from_user_id": other_user_id, "to_user_id": user["user_id"]}
        ]
    }, {"_id": 0}).sort("timestamp", 1).to_list(1000)

    return {"messages": conv}

# ============= TOURNAMENT ROUTES =============

@api_router.post("/tournaments", response_model=TournamentResponse)
async def create_tournament(tournament_data: TournamentCreate, request: Request):
    await get_admin_user(request)
    
    tournament_id = f"tourney_{uuid.uuid4().hex[:12]}"
    
    start_time = tournament_data.start_time
    if not start_time:
        start_time = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
    
    tournament_doc = {
        "tournament_id": tournament_id,
        "name": tournament_data.name,
        "time_control": tournament_data.time_control,
        "entry_fee": tournament_data.entry_fee,
        "entry_currency": tournament_data.entry_currency,
        "prize_pool": 0,
        "min_players": tournament_data.min_players,
        "max_players": tournament_data.max_players,
        "current_players": 0,
        "tournament_type": tournament_data.tournament_type,
        "status": "upcoming",
        "start_time": start_time,
        "end_time": None,
        "duration_minutes": tournament_data.duration_minutes,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "players": [],
        "leaderboard": [],
        "pairings": [],
        "is_private": False,
        "invite_code": None,
        "created_by": None,
    }
    
    await db.tournaments.insert_one(tournament_doc)
    tournament_doc.pop("_id", None)
    
    return TournamentResponse(**tournament_doc)

@api_router.get("/tournaments", response_model=List[TournamentResponse])
async def list_tournaments(status: Optional[str] = None):
    # Phase 4c: private tournaments never show up in the general public
    # listing - they're only reachable via their direct invite link, or
    # via /tournaments/mine for players already in one.
    query = {"is_private": {"$ne": True}}
    if status:
        query["status"] = status

    # Sort by status priority first (active, then upcoming, then completed)
    # so a tournament can't be pushed out of the window just because its
    # start_time was bumped to "now" when it went active. Within each
    # status group, upcoming tournaments show soonest-first and active/
    # completed ones show most-recently-started first.
    pipeline = [
        {"$match": query},
        {"$addFields": {
            "_status_rank": {
                "$switch": {
                    "branches": [
                        {"case": {"$eq": ["$status", "active"]}, "then": 0},
                        {"case": {"$eq": ["$status", "upcoming"]}, "then": 1},
                    ],
                    "default": 2,
                }
            },
            "_time_sort": {
                "$cond": [{"$eq": ["$status", "upcoming"]}, "$start_time", None]
            }
        }},
        {"$sort": {"_status_rank": 1, "_time_sort": 1, "start_time": -1}},
        {"$limit": 50},
        {"$project": {"_id": 0, "_status_rank": 0, "_time_sort": 0}},
    ]
    tournaments = await db.tournaments.aggregate(pipeline).to_list(50)
    return [TournamentResponse(**t) for t in tournaments]

@api_router.get("/tournaments/mine", response_model=List[TournamentResponse])
async def list_my_tournaments(request: Request):
    """
    Tournaments the current user has joined, looked up directly by player
    membership rather than the general (sorted + capped) /tournaments list.
    This avoids the case where a tournament's start_time is bumped to "now"
    when it goes active and gets sorted/paginated out of the general list
    before a player ever sees pairings/leaderboard for it.
    """
    user = await get_current_user(request)
    tournaments = await db.tournaments.find(
        {"players.user_id": user["user_id"]}, {"_id": 0}
    ).sort("start_time", -1).limit(100).to_list(100)
    return [TournamentResponse(**t) for t in tournaments]

@api_router.get("/tournaments/{tournament_id}", response_model=TournamentResponse)
async def get_tournament(tournament_id: str):
    tournament = await db.tournaments.find_one({"tournament_id": tournament_id}, {"_id": 0})
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")
    return TournamentResponse(**tournament)

async def _join_tournament_player(tournament: dict, user: dict) -> None:
    """Shared 'add this user as a tournament player' logic: entry-fee
    deduction + ledger row (if there's an entry fee), then the players/
    leaderboard/current_players/prize_pool update. Extracted so both the
    regular join endpoint and Phase 4c's private-tournament creation
    (where the creator auto-joins their own tournament) go through
    identical accounting - no separate 'creator' code path that could
    drift from the normal join path. Callers are responsible for their
    own pre-checks (status, capacity, not-already-joined, invite code);
    this function only does the join itself."""
    tournament_id = tournament["tournament_id"]

    if tournament["entry_fee"] > 0:
        balance = user.get("wallet_balance", {}).get(tournament["entry_currency"], 0)
        if balance < tournament["entry_fee"]:
            raise HTTPException(status_code=400, detail="Insufficient balance")

        await db.users.update_one(
            {"user_id": user["user_id"]},
            {"$inc": {f"wallet_balance.{tournament['entry_currency']}": -tournament["entry_fee"]}}
        )

        await db.transactions.insert_one({
            "tx_id": f"tx_{uuid.uuid4().hex[:12]}",
            "user_id": user["user_id"],
            "tx_type": "tournament_entry",
            "amount": -tournament["entry_fee"],
            "currency": tournament["entry_currency"],
            "status": "completed",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "related_tournament_id": tournament_id
        })

    player_entry = {
        "user_id": user["user_id"],
        "username": user["username"],
        "rating": user.get("rating", 1200),
        "score": 0,
        "games_played": 0,
        "wins": 0,
        "losses": 0,
        "draws": 0,
        "current_game_id": None,
        "in_match": False,
        "joined_at": datetime.now(timezone.utc).isoformat()
    }

    await db.tournaments.update_one(
        {"tournament_id": tournament_id},
        {
            "$push": {"players": player_entry, "leaderboard": player_entry},
            "$inc": {"current_players": 1, "prize_pool": tournament["entry_fee"]}
        }
    )


@api_router.post("/tournaments/{tournament_id}/join")
async def join_tournament(tournament_id: str, request: Request, join_data: Optional[JoinTournamentRequest] = None):
    user = await get_current_user(request)
    
    tournament = await db.tournaments.find_one({"tournament_id": tournament_id}, {"_id": 0})
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")
    
    if tournament["status"] not in ["upcoming", "active"]:
        raise HTTPException(status_code=400, detail="Cannot join this tournament")
    
    if tournament["current_players"] >= tournament["max_players"]:
        raise HTTPException(status_code=400, detail="Tournament is full")
    
    # Check if already joined
    if any(p["user_id"] == user["user_id"] for p in tournament.get("players", [])):
        raise HTTPException(status_code=400, detail="Already joined this tournament")

    # Phase 4c: private tournaments require the right invite code - this
    # is what makes them "private" rather than just hidden from the list.
    if tournament.get("is_private"):
        provided_code = join_data.invite_code if join_data else None
        if not provided_code or provided_code != tournament.get("invite_code"):
            raise HTTPException(status_code=403, detail="Valid invite code required to join this private tournament")

    await _join_tournament_player(tournament, user)

    if tournament["status"] == "active":
        # Tournament is already running - get this player straight into a
        # match instead of leaving them waiting for someone to click play.
        await auto_pair_tournament(tournament_id)

    return {"success": True, "message": "Joined tournament successfully"}


# ============= PHASE 4c: SOCIAL & COMPETITIVE FEATURES =============
# Feature keys introduced in this phase (price each via
# PUT /admin/credit-feature-costs/{feature_key}, same as 4a/4b):
#   - "private_tournament_create"  one-time charge to create a
#                                   user-owned private tournament
#   - "challenge_invite_extra"     extra challenge sent after
#                                   CHALLENGE_FREE_DAILY_INVITES free ones
#                                   today (daily budget, same pattern as
#                                   Phase 4b's puzzle retries/skips)
#   - "featured_game"              boosts a waiting game to the top of the
#                                   lobby for FEATURED_GAME_MINUTES
#   - "rematch_token"              instantly re-challenges the opponent
#                                   from a just-finished CASUAL game
#
# None of these have a cost until an admin sets one - spend_credits()
# 500s on an unpriced feature_key by design.

# Free daily challenge invites before "challenge_invite_extra" kicks in.
# Same shape as Phase 4b's PUZZLE_FREE_DAILY_* constants - a code-level
# default for the free tier, while the credit *price* stays admin-configurable.
CHALLENGE_FREE_DAILY_INVITES = 5
# How long a boosted ("featured") game stays pinned at the top of the lobby.
FEATURED_GAME_MINUTES = 15


@api_router.post("/tournaments/private", response_model=TournamentResponse)
async def create_private_tournament(tournament_data: PrivateTournamentCreate, request: Request):
    """Phase 4c: any logged-in user (not just admins) can create their own
    private tournament, gated behind credits. Unlike the admin endpoint,
    this always starts private with a fresh invite_code, and the creator
    is auto-joined via the same _join_tournament_player path everyone
    else uses."""
    user = await get_current_user(request)

    if tournament_data.min_players < 2:
        raise HTTPException(status_code=400, detail="min_players must be at least 2")
    if tournament_data.max_players < tournament_data.min_players:
        raise HTTPException(status_code=400, detail="max_players must be >= min_players")

    # Charge before creating anything - if the insert below somehow fails,
    # we refund immediately rather than leave the user billed for a
    # tournament that doesn't exist (same pattern as Phase 2's purchase
    # flow refunding a failed grant_credits after the wallet was debited).
    spend_result = await spend_credits(
        user["user_id"], "private_tournament_create", reference_id=None,
        metadata={"name": tournament_data.name},
    )

    tournament_id = f"tourney_{uuid.uuid4().hex[:12]}"
    invite_code = uuid.uuid4().hex[:10]
    start_time = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()

    tournament_doc = {
        "tournament_id": tournament_id,
        "name": tournament_data.name,
        "time_control": tournament_data.time_control,
        "entry_fee": tournament_data.entry_fee,
        "entry_currency": tournament_data.entry_currency,
        "prize_pool": 0,
        "min_players": tournament_data.min_players,
        "max_players": tournament_data.max_players,
        "current_players": 0,
        "tournament_type": tournament_data.tournament_type,
        "status": "upcoming",
        "start_time": start_time,
        "end_time": None,
        "duration_minutes": tournament_data.duration_minutes,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "players": [],
        "leaderboard": [],
        "pairings": [],
        "is_private": True,
        "invite_code": invite_code,
        "created_by": user["user_id"],
    }

    try:
        await db.tournaments.insert_one(dict(tournament_doc))
    except Exception:
        await grant_credits(
            user["user_id"], spend_result["cost"], "refund",
            reference_id=spend_result.get("tx_id"),
            metadata={"reason": "private_tournament_create_failed"},
        )
        raise

    # Creator auto-joins their own tournament through the normal join
    # path, so they don't need their own invite code and the tournament
    # immediately shows up under /tournaments/mine.
    fresh_user = await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0}) or user
    await _join_tournament_player(tournament_doc, fresh_user)

    final_doc = await db.tournaments.find_one({"tournament_id": tournament_id}, {"_id": 0})
    return TournamentResponse(**final_doc)

@api_router.post("/tournaments/{tournament_id}/leave")
async def leave_tournament(tournament_id: str, request: Request):
    """Let a player exit a tournament they've joined.

    - Upcoming tournament: player is removed and their entry fee is
      refunded in full, since nothing has been played yet.
    - Active tournament: player is removed without a refund (their fee is
      already part of the prize pool other players are competing for). If
      they're mid-match, that game is auto-forfeited as a loss so their
      opponent isn't left waiting on someone who's gone, and the freed-up
      pool is immediately re-paired.
    - Completed tournament: nothing left to leave.
    """
    user = await get_current_user(request)

    tournament = await db.tournaments.find_one({"tournament_id": tournament_id}, {"_id": 0})
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")

    if tournament["status"] == "completed":
        raise HTTPException(status_code=400, detail="Tournament has already ended")

    player = next((p for p in tournament.get("players", []) if p["user_id"] == user["user_id"]), None)
    if not player:
        raise HTTPException(status_code=400, detail="You haven't joined this tournament")

    # If the player is mid-match, forfeit that game on their behalf so the
    # opponent isn't stuck waiting on a match that will never finish.
    active_game_id = player.get("current_game_id")
    if active_game_id:
        game = await db.games.find_one({"game_id": active_game_id}, {"_id": 0})
        if game and game.get("status") == "active":
            leaver_is_white = game["white_player"]["user_id"] == user["user_id"]
            result = "black" if leaver_is_white else "white"
            await db.games.update_one(
                {"game_id": active_game_id},
                {"$set": {
                    "status": "completed",
                    "result": result,
                    "end_reason": "tournament_leave",
                    "ended_at": datetime.now(timezone.utc).isoformat()
                }}
            )
            await sio.emit('game_ended', {
                "game_id": active_game_id,
                "result": result,
                "reason": "tournament_leave",
                "tournament_id": tournament_id
            }, room=active_game_id)
            game["result"] = result
            # Frees both players (in_match -> False) and, for the opponent
            # who's staying, immediately tries to pair them into a new match.
            await update_tournament_leaderboard_for_game(game)
            tournament = await db.tournaments.find_one({"tournament_id": tournament_id}, {"_id": 0})

    refunded = False
    if tournament["status"] == "upcoming" and tournament.get("entry_fee", 0) > 0:
        await db.users.update_one(
            {"user_id": user["user_id"]},
            {"$inc": {f"wallet_balance.{tournament['entry_currency']}": tournament["entry_fee"]}}
        )
        await db.transactions.insert_one({
            "tx_id": f"tx_{uuid.uuid4().hex[:12]}",
            "user_id": user["user_id"],
            "tx_type": "tournament_refund",
            "amount": tournament["entry_fee"],
            "currency": tournament["entry_currency"],
            "status": "completed",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "related_tournament_id": tournament_id
        })
        refunded = True

    prize_pool_decrement = tournament["entry_fee"] if refunded else 0

    await db.tournaments.update_one(
        {"tournament_id": tournament_id},
        {
            "$pull": {
                "players": {"user_id": user["user_id"]},
                "leaderboard": {"user_id": user["user_id"]}
            },
            "$inc": {"current_players": -1, "prize_pool": -prize_pool_decrement}
        }
    )

    await sio.emit('tournament_updated', {"tournament_id": tournament_id})

    if tournament["status"] == "active":
        # The pool just shrank by one - see if anyone still waiting can now
        # be paired (e.g. this was the player an odd-numbered pool was
        # waiting to pair with).
        await auto_pair_tournament(tournament_id)

    message = "You have left the tournament"
    if refunded:
        message += " and your entry fee was refunded"
    return {"success": True, "message": message}

@api_router.post("/tournaments/{tournament_id}/match/random-join")
async def random_tournament_match(tournament_id: str, request: Request):
    user = await get_current_user(request)
    tournament = await db.tournaments.find_one({"tournament_id": tournament_id}, {"_id": 0})
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")
    if tournament["status"] != "active":
        raise HTTPException(status_code=400, detail="Tournament is not active")

    player = next((p for p in tournament.get("players", []) if p["user_id"] == user["user_id"]), None)
    if not player:
        raise HTTPException(status_code=403, detail="You must join the tournament first")
    if player.get("current_game_id"):
        return {"success": True, "game_id": player["current_game_id"], "message": "You already have a tournament match."}

    waiting_players = [p for p in tournament.get("players", []) if not p.get("in_match") and p["user_id"] != user["user_id"]]
    if not waiting_players:
        await sio.emit('admin_alert', {
            "tournament_id": tournament_id,
            "message": f"No opponent available for {user['username']} in tournament {tournament['name']}.",
            "name": tournament.get("name"),
            "current_players": tournament.get("current_players")
        }, room="admin_room")
        raise HTTPException(status_code=400, detail="No opponent available yet. Please try again shortly.")

    opponent = min(waiting_players, key=lambda p: abs(p.get("rating", 1200) - player.get("rating", 1200)))
    white_player, black_player = (
        player, opponent
    ) if player.get("rating", 1200) >= opponent.get("rating", 1200) else (opponent, player)
    game_id = await create_tournament_game(tournament, white_player, black_player)
    pair_obj = {
        "player_white": white_player,
        "player_black": black_player,
        "rating_difference": abs(white_player.get("rating", 1200) - black_player.get("rating", 1200)),
        "game_id": game_id
    }

    updated_players = []
    for p in tournament.get("players", []):
        if p["user_id"] == player["user_id"] or p["user_id"] == opponent["user_id"]:
            p["current_game_id"] = game_id
            p["in_match"] = True
        updated_players.append(p)

    await db.tournaments.update_one(
        {"tournament_id": tournament_id},
        {
            "$set": {
                "players": updated_players
            },
            "$push": {"pairings": pair_obj}
        }
    )

    await sio.emit('tournament_updated', {
        "tournament_id": tournament_id,
        "pairings": [pair_obj],
        "game_id": game_id
    })

    return {"success": True, "game_id": game_id}

@api_router.post("/tournaments/{tournament_id}/start")
async def start_tournament(tournament_id: str, request: Request):
    await get_admin_user(request)
    
    tournament = await db.tournaments.find_one({"tournament_id": tournament_id}, {"_id": 0})
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")
    
    if tournament["status"] != "upcoming":
        raise HTTPException(status_code=400, detail="Tournament already started")
    
    if tournament["current_players"] < 2:
        raise HTTPException(status_code=400, detail="Need at least 2 players to start")

    await activate_tournament(tournament)

    return {"success": True}

@api_router.post("/tournaments/{tournament_id}/end")
async def end_tournament(tournament_id: str, request: Request):
    await get_admin_user(request)
    
    tournament = await db.tournaments.find_one({"tournament_id": tournament_id}, {"_id": 0})
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")
    
    if tournament["status"] != "active":
        raise HTTPException(status_code=400, detail="Tournament is not active")

    await finish_tournament(tournament)

    return {"success": True}

# ============= CREDITS SYSTEM (Phase 1: data model) =============
# Locked decisions — do not change without explicit approval:
#   - Exchange rate: 100 credits = $1 USD
#   - Signup bonus: 400 free credits, granted once, on account creation
#   - Credits are one-way (wallet -> credits) only. Nothing in this module
#     may convert credits back into wallet_balance or touch staked-game
#     settlement. Enforced here at the data layer: grant_credits() is the
#     only function allowed to touch users.credits_balance, and it has no
#     path that writes to wallet_balance.
CREDITS_PER_USD = 100
SIGNUP_BONUS_CREDITS = 400

# Phase 2: preset packs shown in the "Buy credits" UI. Purely a UI
# convenience list (users can also enter a custom amount) - not the same
# thing as credit_feature_costs, which prices what credits can be spent on.
CREDIT_PACKS_USDT = [5, 10, 25, 50, 100]

# credit_transactions.type values used so far: "signup_bonus", "purchase",
# "spend". Phase 3 also adds "refund" once a spend needs reversing.
# Every entry is an immutable row - never updated or deleted, only inserted.
# users.credits_balance is a cached running total; credit_transactions is
# the source of truth and must always be able to reproduce it (see
# compute_credits_balance_from_ledger below).

async def grant_credits(
    user_id: str,
    amount: int,
    tx_type: str,
    reference_id: Optional[str] = None,
    metadata: Optional[dict] = None,
) -> dict:
    """Atomically adjust a user's credits_balance and write an immutable
    ledger row for it. `amount` is signed: positive credits the account,
    negative debits it. This is the only function that should ever modify
    users.credits_balance - Phase 2 (purchases) and Phase 3 (spend) must be
    built on top of this rather than reimplementing the $inc themselves, so
    every balance change is guaranteed to have a matching ledger row.

    For a debit, the balance check and the decrement happen in a single
    atomic find_one_and_update (filtered on credits_balance >= amount owed)
    so two concurrent debits can't both pass a separate balance check and
    take the balance negative.

    Returns the ledger entry that was written. Raises HTTPException(400) if
    a debit would take the balance below zero, and HTTPException(404) if
    the user doesn't exist.
    """
    now = datetime.now(timezone.utc).isoformat()

    if amount < 0:
        updated = await db.users.find_one_and_update(
            {"user_id": user_id, "credits_balance": {"$gte": -amount}},
            {"$inc": {"credits_balance": amount}},
            return_document=ReturnDocument.AFTER,
        )
        if updated is None:
            exists = await db.users.find_one({"user_id": user_id}, {"_id": 0, "user_id": 1})
            if exists is None:
                raise HTTPException(status_code=404, detail="User not found")
            raise HTTPException(status_code=400, detail="Insufficient credits")
    else:
        updated = await db.users.find_one_and_update(
            {"user_id": user_id},
            {"$inc": {"credits_balance": amount}},
            return_document=ReturnDocument.AFTER,
        )
        if updated is None:
            raise HTTPException(status_code=404, detail="User not found")

    resulting_balance = updated.get("credits_balance", 0)

    ledger_entry = {
        "tx_id": f"ctx_{uuid.uuid4().hex[:12]}",
        "user_id": user_id,
        "amount": amount,
        "type": tx_type,
        "reference_id": reference_id,
        "metadata": metadata or {},
        "resulting_balance": resulting_balance,
        "created_at": now,
    }
    await db.credit_transactions.insert_one(dict(ledger_entry))

    return ledger_entry


async def compute_credits_balance_from_ledger(user_id: str) -> int:
    """Recompute a user's credits balance purely by summing their ledger
    rows. Used for auditing - should always equal users.credits_balance."""
    total = 0
    cursor = db.credit_transactions.find({"user_id": user_id}, {"_id": 0, "amount": 1})
    async for entry in cursor:
        total += entry.get("amount", 0)
    return total


async def get_credit_feature_cost(feature_key: str) -> Optional[int]:
    """Look up a feature's credit cost from the credit_feature_costs config
    collection. Returns None if the feature has no configured cost (not
    yet gated). Pricing lives here, not in code, so it can change without
    a deploy - see Phase 4 for feature gating built on this."""
    doc = await db.credit_feature_costs.find_one({"feature_key": feature_key}, {"_id": 0})
    return doc.get("cost") if doc else None


@api_router.get("/credits/balance")
async def get_credits_balance(request: Request):
    user = await get_current_user(request)
    return {
        "credits_balance": user.get("credits_balance", 0),
        "ledger_balance": await compute_credits_balance_from_ledger(user["user_id"]),
    }


@api_router.get("/credits/transactions", response_model=List[CreditTransactionResponse])
async def get_credits_transactions(request: Request):
    user = await get_current_user(request)
    transactions = await db.credit_transactions.find(
        {"user_id": user["user_id"]},
        {"_id": 0},
    ).sort("created_at", -1).limit(50).to_list(50)
    return transactions


# ---- Phase 2: wallet -> credits purchase ----
# One-directional by construction: this is the only route that moves value
# between wallet_balance and credits_balance, and it only ever debits
# wallet_balance / credits grant_credits(). There is no route, here or
# anywhere else in this file, that increments wallet_balance from
# credits_balance - do not add one.
#
# Currently USDT-only. USDT is the only wallet currency this codebase
# already treats as $-pegged (see the 100.0 starting balance vs 0.001 BTC /
# 0.01 ETH), and the locked 100 credits = $1 exchange rate needs a USD
# value to apply to. Supporting BTC/ETH purchases would need a live price
# feed, which doesn't exist yet - flagged rather than guessed at.

@api_router.get("/credits/packs")
async def get_credit_packs():
    return {
        "currency": "USDT",
        "credits_per_usd": CREDITS_PER_USD,
        "packs": [
            {"amount_usdt": amt, "credits": amt * CREDITS_PER_USD}
            for amt in CREDIT_PACKS_USDT
        ],
    }


@api_router.post("/credits/purchase")
async def purchase_credits(purchase_data: BuyCreditsRequest, request: Request):
    user = await get_current_user(request)

    requested_usdt = round(purchase_data.amount_usdt, 2)
    if requested_usdt <= 0:
        raise HTTPException(status_code=400, detail="Amount must be positive")

    # Floor to a whole number of credits, then charge exactly what that many
    # credits cost - never round in the user's favor (free credits) or the
    # house's favor (overcharging a fraction of a cent past what the
    # displayed credit amount implies).
    credits_to_grant = int(requested_usdt * CREDITS_PER_USD)
    if credits_to_grant < 1:
        raise HTTPException(
            status_code=400,
            detail=f"Minimum purchase is {1 / CREDITS_PER_USD:.2f} USDT (1 credit)",
        )
    actual_cost_usdt = credits_to_grant / CREDITS_PER_USD

    # Atomic, conditional debit: the filter re-checks the balance at update
    # time, so two concurrent purchase requests can't both read a
    # sufficient balance and then both deduct - the second one simply
    # doesn't match once the first has applied.
    updated_user = await db.users.find_one_and_update(
        {"user_id": user["user_id"], "wallet_balance.USDT": {"$gte": actual_cost_usdt}},
        {"$inc": {"wallet_balance.USDT": -actual_cost_usdt}},
        return_document=ReturnDocument.AFTER,
    )
    if updated_user is None:
        raise HTTPException(status_code=400, detail="Insufficient USDT balance")

    wallet_tx_id = f"tx_{uuid.uuid4().hex[:12]}"
    await db.transactions.insert_one({
        "tx_id": wallet_tx_id,
        "user_id": user["user_id"],
        "tx_type": "credits_purchase",
        "amount": -actual_cost_usdt,
        "currency": "USDT",
        "status": "completed",
        "created_at": datetime.now(timezone.utc).isoformat(),
    })

    try:
        await grant_credits(
            user["user_id"],
            credits_to_grant,
            "purchase",
            reference_id=wallet_tx_id,
            metadata={"usdt_spent": actual_cost_usdt},
        )
    except HTTPException:
        # The wallet debit above already succeeded; grant_credits failing
        # (only possible if the user vanished between the debit and here)
        # would otherwise leave USDT deducted with nothing credited. Refund
        # it. This is a compensating action, not a two-phase commit - this
        # deployment's MongoDB isn't assumed to be a replica set, so we
        # can't wrap both writes in a real multi-document transaction.
        await db.users.update_one(
            {"user_id": user["user_id"]},
            {"$inc": {"wallet_balance.USDT": actual_cost_usdt}},
        )
        await db.transactions.insert_one({
            "tx_id": f"tx_{uuid.uuid4().hex[:12]}",
            "user_id": user["user_id"],
            "tx_type": "credits_purchase_refund",
            "amount": actual_cost_usdt,
            "currency": "USDT",
            "status": "completed",
            "related_tx_id": wallet_tx_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
        raise

    final_user = await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0})
    return {
        "success": True,
        "credits_purchased": credits_to_grant,
        "cost_usdt": actual_cost_usdt,
        "wallet_balance": final_user.get("wallet_balance"),
        "credits_balance": final_user.get("credits_balance"),
        "tx_id": wallet_tx_id,
    }


# ---- Phase 3: generic credit-spend mechanism ----
# The ONE reusable spend path. Every gated feature in Phase 4 must call
# spend_credits() (or hit POST /credits/spend) rather than writing its own
# balance-check-and-deduct logic, so cost lookup, the atomic debit, the
# ledger row, and the insufficient-credits response shape are guaranteed
# identical everywhere a feature gets gated.

async def spend_credits(
    user_id: str,
    feature_key: str,
    reference_id: Optional[str] = None,
    metadata: Optional[dict] = None,
) -> dict:
    """Look up feature_key's cost in credit_feature_costs and debit it
    atomically via grant_credits. Raises HTTPException(500) if the feature
    has no configured cost (Phase 4 must price a feature here before
    gating it), or HTTPException(402) with a structured body if the user
    doesn't have enough credits - the frontend can key off
    detail.error == "insufficient_credits" to show a buy-more-credits
    prompt instead of a bare error."""
    cost = await get_credit_feature_cost(feature_key)
    if cost is None:
        raise HTTPException(
            status_code=500,
            detail=f"No credit cost configured for feature '{feature_key}'",
        )
    if cost <= 0:
        # Cost intentionally set to 0 (e.g. admin comped it) - nothing to
        # deduct, nothing to ledger.
        return {"success": True, "feature_key": feature_key, "cost": 0, "free": True}

    full_metadata = {"feature_key": feature_key, **(metadata or {})}
    try:
        ledger_entry = await grant_credits(
            user_id,
            -cost,
            "spend",
            reference_id=reference_id or feature_key,
            metadata=full_metadata,
        )
    except HTTPException as e:
        if e.status_code == 400 and e.detail == "Insufficient credits":
            current = await db.users.find_one({"user_id": user_id}, {"_id": 0, "credits_balance": 1})
            current_balance = current.get("credits_balance", 0) if current else 0
            raise HTTPException(
                status_code=402,
                detail={
                    "error": "insufficient_credits",
                    "feature_key": feature_key,
                    "cost": cost,
                    "credits_balance": current_balance,
                    "shortfall": cost - current_balance,
                },
            )
        raise

    return {
        "success": True,
        "feature_key": feature_key,
        "cost": cost,
        "credits_balance": ledger_entry["resulting_balance"],
        "tx_id": ledger_entry["tx_id"],
    }


@api_router.post("/credits/spend")
async def spend_credits_endpoint(spend_data: SpendCreditsRequest, request: Request):
    user = await get_current_user(request)
    return await spend_credits(
        user["user_id"],
        spend_data.feature_key,
        reference_id=spend_data.reference_id,
        metadata=spend_data.metadata,
    )


# ---- Phase 3: admin management of credit_feature_costs ----
# "All credit costs are configurable, not hardcoded" - this is how pricing
# changes without a deploy. Phase 4 gated features will each need a row
# here before they can be gated (spend_credits 500s otherwise).

@api_router.get("/admin/credit-feature-costs")
async def admin_list_credit_feature_costs(request: Request):
    await get_admin_user(request)
    costs = await db.credit_feature_costs.find({}, {"_id": 0}).sort("feature_key", 1).to_list(500)
    return costs


@api_router.put("/admin/credit-feature-costs/{feature_key}")
async def admin_set_credit_feature_cost(feature_key: str, update: CreditFeatureCostUpdate, request: Request):
    await get_admin_user(request)
    if update.cost < 0:
        raise HTTPException(status_code=400, detail="Cost must be >= 0")

    await db.credit_feature_costs.update_one(
        {"feature_key": feature_key},
        {
            "$set": {
                "feature_key": feature_key,
                "cost": update.cost,
                "category": update.category,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        },
        upsert=True,
    )
    return {"success": True}

# ============= PHASE 4a: ANALYSIS & POST-GAME TOOLS =============
# Feature keys introduced in this phase (price each via
# PUT /admin/credit-feature-costs/{feature_key} - nothing here is
# hardcoded, per the locked "all credit costs are configurable" decision):
#   - "game_review"          per-user, per-game unlock of the post-game
#                             blunder/accuracy report. Always runs at deep
#                             depth (ANALYSIS_DEPTH). Gated by its own
#                             lifetime allowance: the first
#                             GAME_REVIEW_FREE_LIMIT games a user reviews
#                             are free, every one after that costs
#                             "game_review" credits.
#   - "board_analysis"       per-use charge for the Board Editor's
#                             "Analyze" button (arbitrary custom
#                             positions, not tied to a saved game). Always
#                             runs at deep depth. Gated by its own,
#                             separate lifetime allowance: the first
#                             BOARD_ANALYSIS_FREE_LIMIT analyses are free,
#                             every one after that costs "board_analysis"
#                             credits. Deliberately a *different* budget
#                             from game_review's so the two never share a
#                             counter, per spec.
#   - "pgn_deep_analysis"    deep analysis of an arbitrary imported PGN,
#                             charged once per distinct PGN per user
#   - "opening_explorer_deep" per-query cost for opening-explorer lookups
#                             beyond the free shallow depth
#
# None of these have a cost until an admin sets one via the endpoint
# above - spend_credits() 500s on an unpriced feature_key by design, so a
# feature can't accidentally go live unpriced.
#
# NOTE: there used to be a separate "deep_analysis" feature/endpoint
# offering a deeper re-analysis on top of the standard game_review. It has
# been retired: game_review now runs at that same deep depth directly
# (there's no more "shallow" review to upsell from), which also removes
# the bug where /games/{game_id}/deep-analysis charged credits up front
# and had no refund path when the underlying Stockfish run failed - see
# _refund_unlock_claim / _refund_lifetime_spend below.

ANALYSIS_DEPTH = 20  # deep depth used by both Game Review and Board Editor analysis
PGN_ANALYSIS_DEPTH = 18
# First 3 full moves (6 ply) of the in-house opening explorer are free;
# looking deeper than that costs credits. "Basic depth" per the spec.
OPENING_EXPLORER_FREE_PLY = 6

# Caps how many of these deep (Hash: 128MB+) Stockfish subprocesses can
# run at once - across Board Editor and Game Review's background jobs,
# and the older synchronous Game Review / PGN-import analysis endpoints
# that spawn the same kind of engine. Nothing bounded this before: each
# caller spins up its own Stockfish process via asyncio.to_thread with
# no shared limit, so N of these running at once means N x ~150-200MB
# of engine memory on top of the app itself - easy to blow past a
# memory-constrained host's limit (e.g. Render's smaller instance
# tiers) well before any single analysis is slow or wrong. That failure
# mode looks exactly like "Stockfish works, but the server keeps
# randomly crashing and restarting" - the crash is memory pressure, not
# a bad analysis.
#
# This matters even more with crash-resume in the picture:
# _resume_orphaned_board_analysis_jobs / _resume_orphaned_game_review_jobs
# can fire off asyncio.create_task for every job that was still pending
# when the process died - potentially several at once, immediately at
# startup, with no throttling of their own. Without this semaphore
# that's a self-sustaining crash loop: the burst of concurrent Stockfish
# processes that helped OOM the process the first time gets relaunched
# in full the moment it restarts. Every caller acquires this before
# starting its Stockfish subprocess, so only STOCKFISH_MAX_CONCURRENT
# ever run at once no matter how many jobs got created/resumed/requested
# simultaneously - the rest simply wait their turn.
#
# Default of 1 (not 2) is sized for a 512MB Render instance specifically:
# base app memory (uvicorn/FastAPI/Motor/socketio/APScheduler + everything
# else already loaded) plus even ONE Hash:64 engine process already
# leaves little headroom on a 512MB box - two concurrent Hash:128
# engines (the pre-fix setting) was comfortably enough on its own to
# explain an exit-137 OOM kill. Bump this via the env var if/when this
# service moves to a larger instance.
STOCKFISH_MAX_CONCURRENT = int(os.environ.get("STOCKFISH_MAX_CONCURRENT", "1"))
_stockfish_job_slots = asyncio.Semaphore(STOCKFISH_MAX_CONCURRENT)

# Lifetime (not daily/monthly) free-use allowances before credits are
# charged. Separate constants/budgets per spec - Board Editor analysis and
# Game Review never share a counter, even though they're priced the same.
GAME_REVIEW_FREE_LIMIT = 5
BOARD_ANALYSIS_FREE_LIMIT = 5


async def _claim_unlock(
    collection,
    user_id: str,
    doc_key: dict,
    feature_key: str,
    reference_id: Optional[str] = None,
) -> dict:
    """Atomically claim a one-time-per-user unlock recorded in `collection`
    (keyed on user_id + doc_key), charging `feature_key` credits exactly
    once for it. Built for features where the underlying computation may
    be shared/cached (e.g. a game's Stockfish review), but each user
    should still only ever be billed once for unlocking access to it.

    The (user_id + doc_key) slot is claimed with an atomic insert BEFORE
    credits are charged, so two concurrent requests for the same unlock
    can't both observe "not yet unlocked" and both get charged. If the
    charge then fails (e.g. insufficient credits), the claim is rolled
    back immediately so the user isn't left locked out without having
    paid.

    Returns {"already_unlocked": bool, "unlock": dict, "spend": dict|None}.
    Raises whatever spend_credits() raises (e.g. HTTPException 402) if a
    fresh charge is attempted and fails.
    """
    existing = await collection.find_one({"user_id": user_id, **doc_key}, {"_id": 0})
    if existing:
        return {"already_unlocked": True, "unlock": existing, "spend": None}

    claim_doc = {
        "user_id": user_id,
        **doc_key,
        "tx_id": None,
        "claimed_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        await collection.insert_one(dict(claim_doc))
    except DuplicateKeyError:
        # Lost the race to a concurrent request for the same unlock -
        # that request is the one paying for it, not us.
        existing = await collection.find_one({"user_id": user_id, **doc_key}, {"_id": 0})
        return {"already_unlocked": True, "unlock": existing, "spend": None}

    try:
        spend_result = await spend_credits(user_id, feature_key, reference_id=reference_id, metadata=doc_key)
    except HTTPException:
        await collection.delete_one({"user_id": user_id, **doc_key})
        raise

    await collection.update_one(
        {"user_id": user_id, **doc_key},
        {"$set": {"tx_id": spend_result["tx_id"]}},
    )
    claim_doc["tx_id"] = spend_result["tx_id"]
    return {"already_unlocked": False, "unlock": claim_doc, "spend": spend_result}


async def _claim_unlock_with_free_tier(
    collection,
    user_id: str,
    doc_key: dict,
    budget_key: str,
    free_limit: int,
    feature_key: str,
    reference_id: Optional[str] = None,
) -> dict:
    """Like _claim_unlock, but the charge itself is gated by a lifetime
    free-then-paid allowance instead of always costing `feature_key`
    credits: a user's first `free_limit` claims against this `collection`
    are free, and only claims after that spend credits. Built for
    Game Review, where "claims against this collection" already IS the
    per-user, per-game unlock count (one doc per user+game), so the free
    tier can be counted directly off `collection` with no separate
    counter needed.

    Same claim-before-charge race safety as _claim_unlock: the (user_id +
    doc_key) slot is claimed with an atomic insert first, so two
    concurrent requests for the same doc_key can't both see "not yet
    claimed". If a fresh charge is then attempted and fails, the claim is
    rolled back immediately.

    Returns {"already_unlocked": bool, "unlock": dict, "spend": dict|None,
    "paid": bool}. Raises whatever spend_credits() raises (e.g.
    HTTPException 402) if a fresh paid charge fails.
    """
    existing = await collection.find_one({"user_id": user_id, **doc_key}, {"_id": 0})
    if existing:
        return {"already_unlocked": True, "unlock": existing, "spend": None, "paid": bool(existing.get("paid"))}

    claim_doc = {
        "user_id": user_id,
        **doc_key,
        "tx_id": None,
        "paid": False,
        "claimed_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        await collection.insert_one(dict(claim_doc))
    except DuplicateKeyError:
        # Lost the race to a concurrent request for the same unlock -
        # that request is the one paying for it, not us.
        existing = await collection.find_one({"user_id": user_id, **doc_key}, {"_id": 0})
        return {"already_unlocked": True, "unlock": existing, "spend": None, "paid": bool((existing or {}).get("paid"))}

    # This claim is now counted in `collection`, so subtract 1 to get the
    # count of claims that existed BEFORE it, which is what decides
    # whether this one falls inside the free tier.
    prior_count = await collection.count_documents({"user_id": user_id}) - 1
    paid = prior_count >= free_limit

    spend_result = None
    if paid:
        try:
            spend_result = await spend_credits(user_id, feature_key, reference_id=reference_id, metadata=doc_key)
        except HTTPException:
            await collection.delete_one({"user_id": user_id, **doc_key})
            raise

    await collection.update_one(
        {"user_id": user_id, **doc_key},
        {"$set": {"tx_id": spend_result["tx_id"] if spend_result else None, "paid": paid}},
    )
    claim_doc["tx_id"] = spend_result["tx_id"] if spend_result else None
    claim_doc["paid"] = paid
    return {"already_unlocked": False, "unlock": claim_doc, "spend": spend_result, "paid": paid}


async def _refund_unlock_claim(
    collection,
    user_id: str,
    doc_key: dict,
    claim_result: dict,
    feature_key: str,
    reason: str,
) -> None:
    """Undo a claim made by _claim_unlock / _claim_unlock_with_free_tier
    when the gated action it was paying for turned out to fail. Deletes
    the claim doc (freeing the slot so the user can retry without being
    treated as "already unlocked") and, if credits were actually spent,
    refunds them via an explicit "refund" ledger entry. A no-op if the
    claim was for an already-existing unlock (claim_result["already_unlocked"]
    is True) - that one wasn't newly charged by this request, so there's
    nothing for this request to refund or delete.
    """
    if claim_result.get("already_unlocked"):
        return
    await collection.delete_one({"user_id": user_id, **doc_key})
    spend = claim_result.get("spend")
    if spend and spend.get("cost"):
        await grant_credits(
            user_id, spend["cost"], "refund",
            reference_id=spend.get("tx_id"),
            metadata={"feature_key": feature_key, "reason": reason, **doc_key},
        )


async def _consume_lifetime_budget(user_id: str, budget_key: str, free_limit: int, feature_key: str, reference_id: Optional[str] = None) -> dict:
    """Lifetime (never-resetting) counterpart to _consume_daily_budget /
    _consume_monthly_budget, for features with no natural per-document
    dedup key to count against (unlike Game Review, every Board Editor
    analysis is a fresh billable action, not "unlock this game forever").
    Tracked on db.feature_usage_counters, one doc per user, one counter
    field per budget_key so multiple lifetime budgets can share the
    collection without colliding.

    Call this BEFORE the action it gates. Does NOT increment the counter
    itself - call _record_lifetime_usage after the gated action actually
    succeeds, so a failed or unpaid-for action never counts against the
    free allowance (matching the "refund on failure" requirement: a
    request that fails after being charged is refunded in full and also
    doesn't burn a free use).
    """
    doc = await db.feature_usage_counters.find_one({"user_id": user_id}, {"_id": 0}) or {}
    used = doc.get(f"{budget_key}_count", 0)

    if used < free_limit:
        return {"paid": False, "used": used, "free_limit": free_limit, "spend": None}

    spend_result = await spend_credits(user_id, feature_key, reference_id=reference_id, metadata={"budget_key": budget_key})
    return {"paid": True, "used": used, "free_limit": free_limit, "spend": spend_result}


async def _record_lifetime_usage(user_id: str, budget_key: str) -> None:
    """Increments the lifetime usage counter for _consume_lifetime_budget -
    call only after the gated action actually succeeded."""
    await db.feature_usage_counters.update_one(
        {"user_id": user_id},
        {"$inc": {f"{budget_key}_count": 1}},
        upsert=True,
    )


async def _refund_lifetime_spend(user_id: str, spend_result: Optional[dict], feature_key: str, reason: str) -> None:
    """Refunds a charge made by _consume_lifetime_budget when the action it
    was paying for failed. No-op if the budget call didn't actually spend
    anything (the use was free)."""
    if spend_result and spend_result.get("cost"):
        await grant_credits(
            user_id, spend_result["cost"], "refund",
            reference_id=spend_result.get("tx_id"),
            metadata={"feature_key": feature_key, "reason": reason},
        )


def _parse_pgn_to_uci_moves(pgn_text: str):
    """Parse a PGN string into (uci_moves, starting_fen). starting_fen is
    None when the game starts from the standard position. Raises
    ValueError on unparseable PGN or a PGN with no moves."""
    import chess
    import chess.pgn

    game = chess.pgn.read_game(io.StringIO(pgn_text))
    if game is None:
        raise ValueError("Could not parse PGN")

    board = game.board()
    starting_fen = board.fen() if board.fen() != chess.Board().fen() else None

    uci_moves = []
    node = game
    while node.variations:
        next_node = node.variations[0]
        uci_moves.append(next_node.move.uci())
        node = next_node

    if not uci_moves:
        raise ValueError("PGN has no moves to analyze")

    return uci_moves, starting_fen


class BoardAnalyzeRequest(BaseModel):
    fen: str
    multi_pv: int = 3


# Board Editor's async analysis jobs are persisted in db.board_analysis_jobs
# rather than kept in an in-process dict. Worth being precise about what
# this does and doesn't buy: a restart still kills the asyncio.create_task
# running the actual Stockfish search along with the process, so a job
# that was genuinely mid-analysis when the server restarts loses that
# in-progress search - there's no saved engine state to pick back up
# from. What persistence DOES fix is any scenario where the POST that
# creates a job and the GET that polls it can land on different
# processes (multiple workers/instances, or a redeploy landing between
# kickoff and the first poll) - an in-memory dict would 404 there even
# though nothing actually went wrong. It also makes job state
# inspectable in the DB rather than opaque in-process state.
#
# Because the doc holds everything _run_board_analysis_job needs (fen,
# multi_pv, user_id, and the already-decided paid/free "budget" for this
# analysis - see _consume_lifetime_budget), it also doubles as a resume
# ticket: _resume_orphaned_board_analysis_jobs() (called once at
# startup) finds any job still "pending" after a restart and re-runs the
# search from scratch under the SAME job_id, with the SAME paid/free
# status. The frontend, which has just been polling GET
# /board/analyze/{job_id} the whole time, never sees anything but a
# slightly longer "pending". See that function's docstring for the full
# reasoning. Jobs are deleted once their result has been delivered to
# the client (or once an error result has been delivered).


async def _claim_job_settlement(collection, job_id: str) -> bool:
    """Atomically claims the one-time "settle this job's ledger effect"
    slot for job_id in `collection` - i.e. the single credits-ledger call
    (record a free/paid use, or refund a charge) that's allowed to happen
    for this job. Shared by both Board Editor analysis jobs
    (db.board_analysis_jobs) and Game Review jobs (db.game_review_jobs) -
    both persist background Stockfish work as a job doc and both need
    the same "only settle once, even if a crash-resumed replay reruns
    this job" guarantee.

    Returns True if this call just won the claim - it's the one that
    should actually run the ledger side effect. Returns False if some
    earlier run of this same job_id already won it.

    This exists for one specific crash window: the job runner
    records/refunds, THEN writes the job doc's final status ("done" /
    "error"). If the process dies in between those two writes, the job
    doc is still "pending" - so the matching "resume orphaned jobs"
    startup routine will replay this exact job on the next boot, which
    would otherwise call the ledger function a second time for an effect
    that already happened. The "settled" flag on the job doc is claimed
    with a single atomic find_one_and_update (filtered on {"settled":
    {"$ne": True}}), so only the run that wins the race actually touches
    credits/usage counters - a replay that finds it already claimed does
    everything else (re-runs Stockfish, writes the final status) but
    skips the ledger call entirely.
    """
    claim = await collection.find_one_and_update(
        {"job_id": job_id, "settled": {"$ne": True}},
        {"$set": {"settled": True}},
    )
    return claim is not None


async def _run_board_analysis_job(job_id: str, fen: str, multi_pv: int, user_id: str, budget: dict):
    """Runs the actual Stockfish search for a board-analysis job in the
    background, off the request/response cycle entirely, and writes the
    result to db.board_analysis_jobs for the poll endpoint to pick up.

    This exists because a genuinely deep search (ANALYSIS_DEPTH) can take
    far longer on Render's shared/fractional CPU than any single HTTP
    request should ever be kept open for - Render's own proxy has a
    timeout independent of anything in this app, and a slow shared CPU can
    blow past it even with the work correctly off the event loop
    (asyncio.to_thread alone fixes "freezes the whole server", not "this
    one request takes too long"). Moving the work out of the request/
    response cycle entirely - kick off + poll - is the only way to support
    a deep search reliably regardless of how long it actually takes.

    Can run more than once for the same job_id - once from the original
    POST /board/analyze, and again (with identical arguments) from
    _resume_orphaned_board_analysis_jobs if the first run's process died
    before finishing. See _claim_job_settlement for how that's kept from
    double-recording usage or double-refunding credits.
    """
    try:
        def _run():
            # Hash halved from 128 - see _stockfish_job_slots's docstring.
            local_engine = Stockfish(path=STOCKFISH_PATH, depth=ANALYSIS_DEPTH, parameters={"Threads": 1, "Hash": 64})
            local_engine.set_fen_position(fen)
            best_move = local_engine.get_best_move()
            evaluation = local_engine.get_evaluation() or {}
            top_moves = local_engine.get_top_moves(multi_pv) if multi_pv > 1 else []
            if not best_move:
                raise RuntimeError("Stockfish returned no move for this position")
            return best_move, evaluation, top_moves

        # See _stockfish_job_slots's docstring - caps how many of these
        # run concurrently across every Board Editor/Game Review job.
        async with _stockfish_job_slots:
            best_move, evaluation, top_moves = await asyncio.to_thread(_run)

        # Only the run that wins the settlement claim records the free/
        # paid use. free_remaining is still computed off budget["used"] -
        # a snapshot taken when the job was first created, before either
        # run recorded anything - so it comes out correct either way: at
        # most one run ever actually increments the counter, so
        # budget["used"] + 1 is the right post-analysis count regardless
        # of which run (original or resumed) is the one that recorded it.
        if await _claim_job_settlement(db.board_analysis_jobs, job_id):
            await _record_lifetime_usage(user_id, "board_analysis")
        free_remaining = 0 if budget["paid"] else max(0, BOARD_ANALYSIS_FREE_LIMIT - (budget["used"] + 1))
        await db.board_analysis_jobs.update_one(
            {"job_id": job_id},
            {"$set": {
                "status": "done",
                "result": {
                    "move": best_move,
                    "evaluation": evaluation,
                    "top_moves": top_moves,
                    "depth": ANALYSIS_DEPTH,
                    "engine_available": True,
                    "paid": budget["paid"],
                    "cost": budget["spend"]["cost"] if budget["spend"] else 0,
                    "free_uses_remaining": free_remaining,
                    "free_limit": BOARD_ANALYSIS_FREE_LIMIT,
                },
                "updated_at": datetime.now(timezone.utc),
            }},
        )
    except Exception as e:
        logger.error(f"Board Editor analysis failed (job {job_id}): {e}")
        # All credits refunded if the analysis fails - and if it was a
        # free use, it isn't burned either (we never called
        # _record_lifetime_usage above in that case). Same settlement
        # claim as the success path, so a resumed replay that fails
        # again (e.g. a deterministically bad fen) can't refund twice.
        if await _claim_job_settlement(db.board_analysis_jobs, job_id):
            await _refund_lifetime_spend(user_id, budget["spend"], "board_analysis", reason=str(e))
        await db.board_analysis_jobs.update_one(
            {"job_id": job_id},
            {"$set": {
                "status": "error",
                "error": "Deep analysis failed - any credits charged have been refunded",
                "updated_at": datetime.now(timezone.utc),
            }},
        )


async def _resume_orphaned_board_analysis_jobs():
    """Crash-resume for Board Editor analysis jobs. Called once from
    startup_tasks(), before the app starts serving traffic.

    Why "pending" at this exact moment can only mean "orphaned by a
    crash": this function runs before anything else in the new process
    has had a chance to create an analysis job, and the old process (if
    any) is gone by definition - a fresh boot means nothing is racing us
    for these docs. So every job doc still sitting in status "pending"
    right now was left mid-analysis by a previous process that died
    (crashed, was killed, redeployed mid-search, whatever) before it
    could write "done" or "error".

    We can't resume the killed Stockfish search itself - there's no
    saved engine state to continue from, only the inputs it started
    with. So this re-runs the search from scratch. But "from scratch"
    at the engine level is invisible at the product level: we replay it
    under the exact same job_id, against the exact same fen, and - this
    is the part that actually matters to the user - against the exact
    same paid/free "budget" that was already decided (and, if paid,
    already charged) back when the job was first created. The frontend
    has been polling GET /board/analyze/{job_id} this whole time and
    can't tell the difference between "still thinking" and "the server
    restarted and started this job over"; it just sees pending for a bit
    longer, then gets its result. No double-charging and no double-
    recording: _run_board_analysis_job's ledger effect (record a free
    use, or refund credits on failure) is guarded by an atomic per-
    job_id claim (_claim_job_settlement) rather than by "this is the
    first time we've run this job" - so it's safe even in the narrow
    case where the previous process died AFTER recording/refunding but
    BEFORE marking the job doc "done"/"error", which is exactly the
    kind of half-finished state a crash can leave behind.
    """
    resumed = 0
    async for job in db.board_analysis_jobs.find({"status": "pending"}):
        job_id = job.get("job_id")
        fen = job.get("fen")
        budget = job.get("budget")
        user_id = job.get("user_id")
        multi_pv = job.get("multi_pv") or 1

        if not job_id or not fen or budget is None or not user_id:
            # A job doc missing the fields this needs to replay it -
            # e.g. one created by an older deploy of this endpoint,
            # from before fen/multi_pv/budget were persisted on it.
            # There's nothing safe to resume, so fail it outright
            # (refunding anything charged) instead of leaving it stuck
            # in "pending" forever with a frontend polling it forever.
            logger.warning(
                f"Board Editor analysis job {job.get('job_id')} orphaned by "
                "restart but missing fields needed to resume it - marking as error"
            )
            if job_id:
                # Same settlement claim as the normal paths - if this job
                # doc is old enough to be missing fen/budget, it predates
                # "settled" too, so this always wins the claim in
                # practice, but the check is cheap insurance against ever
                # refunding the same job twice.
                if budget is not None and await _claim_job_settlement(db.board_analysis_jobs, job_id):
                    await _refund_lifetime_spend(
                        user_id, budget.get("spend"), "board_analysis",
                        reason="server restarted and job could not be resumed",
                    )
                await db.board_analysis_jobs.update_one(
                    {"job_id": job_id},
                    {"$set": {
                        "status": "error",
                        "error": "Deep analysis failed - any credits charged have been refunded",
                        "updated_at": datetime.now(timezone.utc),
                    }},
                )
            continue

        asyncio.create_task(
            _run_board_analysis_job(job_id, fen, multi_pv, user_id, budget)
        )
        resumed += 1

    if resumed:
        logger.info(
            f"Resumed {resumed} Board Editor analysis job(s) orphaned by a restart"
        )


# ---- Board Editor position analysis ----
# The Board Editor's "Analyze" button, for arbitrary custom positions (not
# tied to any saved game). Always runs Stockfish at deep depth
# (ANALYSIS_DEPTH) - there's no separate "quick preview" tier here. Gated
# by its own lifetime allowance (feature/budget key "board_analysis"):
# the user's first BOARD_ANALYSIS_FREE_LIMIT analyses are free, every one
# after that costs credits.
#
# This is deliberately a NEW, separate endpoint from POST /computer/move
# (which the Board Editor's Analyze button used to call). /computer/move
# stays exactly as it is and is NOT credit-gated, because it also powers
# the actual computer-opponent move generation in Play vs Computer -
# gating it would have started charging people for playing bot games.
#
# This POST kicks the search off in the background and returns almost
# immediately with a job_id - it does NOT wait for Stockfish to finish.
# The frontend polls GET /board/analyze/{job_id} until status is "done"
# or "error". See _run_board_analysis_job's docstring for why: a single
# blocking request/response can't safely support a genuinely deep search
# on Render's shared/fractional CPU, no matter how the work is threaded.
@api_router.post("/board/analyze")
async def analyze_board_position(analyze_req: BoardAnalyzeRequest, request: Request):
    user = await get_current_user(request)

    if not STOCKFISH_AVAILABLE:
        raise HTTPException(status_code=503, detail="Stockfish engine not available")

    try:
        import chess
        chess.Board(analyze_req.fen)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid FEN")

    # Checked BEFORE spending anything, same reasoning as Game Review:
    # a user shouldn't burn a free use or get charged for an analysis
    # that can't actually run.
    budget = await _consume_lifetime_budget(
        user["user_id"], "board_analysis", BOARD_ANALYSIS_FREE_LIMIT,
        "board_analysis", reference_id=analyze_req.fen,
    )

    multi_pv = analyze_req.multi_pv if analyze_req.multi_pv and analyze_req.multi_pv > 1 else 1
    job_id = f"ba_{uuid.uuid4().hex[:12]}"
    await db.board_analysis_jobs.insert_one({
        "job_id": job_id,
        "user_id": user["user_id"],
        "status": "pending",
        # fen/multi_pv/budget are stored (not just passed to the task
        # below) so that if this process dies before the job finishes,
        # _resume_orphaned_board_analysis_jobs() has everything it needs
        # to replay this exact analysis - same position, same paid/free
        # status - under this same job_id after a restart.
        "fen": analyze_req.fen,
        "multi_pv": multi_pv,
        "budget": budget,
        # Claimed exactly once by _claim_job_settlement before this job's
        # ledger effect (record usage / refund credits) runs - guards
        # against a crash-resumed replay double-recording or double-
        # refunding. See that function's docstring.
        "settled": False,
        "created_at": datetime.now(timezone.utc),
    })
    asyncio.create_task(
        _run_board_analysis_job(job_id, analyze_req.fen, multi_pv, user["user_id"], budget)
    )

    return {"job_id": job_id, "status": "pending"}


@api_router.get("/board/analyze/{job_id}")
async def get_board_analysis_job(job_id: str, request: Request):
    user = await get_current_user(request)
    job = await db.board_analysis_jobs.find_one({"job_id": job_id}, {"_id": 0})
    if not job or job.get("user_id") != user["user_id"]:
        raise HTTPException(status_code=404, detail="Analysis job not found")

    if job["status"] == "pending":
        return {"status": "pending"}
    if job["status"] == "error":
        await db.board_analysis_jobs.delete_one({"job_id": job_id})
        raise HTTPException(status_code=503, detail=job["error"])

    # "done" - return the stored result and delete the job doc, same shape
    # the old synchronous endpoint used to return directly.
    result = job["result"]
    await db.board_analysis_jobs.delete_one({"job_id": job_id})
    return {"status": "done", **result}


# ---- Deep/cloud analysis on imported PGNs ----
# For arbitrary PGNs pasted into /import-pgn that aren't a StakeChess
# game - so there's no game_id or participant check, just the pasted PGN
# text itself. Charged once per distinct PGN per user (keyed by a hash of
# the PGN text); re-submitting the exact same PGN returns the cached
# result for free rather than charging again.

@api_router.post("/pgn/analyze")
async def analyze_imported_pgn(analyze_data: PGNAnalyzeRequest, request: Request):
    user = await get_current_user(request)

    pgn_text = (analyze_data.pgn or "").strip()
    if not pgn_text:
        raise HTTPException(status_code=400, detail="PGN text is required")

    try:
        uci_moves, starting_fen = _parse_pgn_to_uci_moves(pgn_text)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    pgn_hash = hashlib.sha256(pgn_text.encode("utf-8")).hexdigest()[:24]

    claim = await _claim_unlock(
        db.pgn_analysis_cache, user["user_id"], {"pgn_hash": pgn_hash},
        "pgn_deep_analysis", reference_id=pgn_hash,
    )

    if claim["already_unlocked"] and claim["unlock"].get("analysis"):
        return {"success": True, "analysis": claim["unlock"]["analysis"], "cached": True}

    if not STOCKFISH_AVAILABLE:
        raise HTTPException(status_code=503, detail="Stockfish engine not available")

    # Shares the same global concurrency cap as Board Editor/Game Review's
    # background jobs - see _stockfish_job_slots's docstring.
    async with _stockfish_job_slots:
        analysis = await asyncio.to_thread(analyze_game_with_stockfish, uci_moves, starting_fen, PGN_ANALYSIS_DEPTH)
    if not analysis.get("engine_available"):
        raise HTTPException(status_code=503, detail=analysis.get("error", "PGN analysis failed"))

    analysis_doc = {
        "analysis_id": f"pan_{uuid.uuid4().hex[:12]}",
        "depth": analysis.get("depth", PGN_ANALYSIS_DEPTH),
        "summary": analysis.get("summary"),
        "moves": analysis.get("moves"),
        "engine_available": True,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.pgn_analysis_cache.update_one(
        {"user_id": user["user_id"], "pgn_hash": pgn_hash},
        {"$set": {"analysis": analysis_doc}},
    )
    return {"success": True, "analysis": analysis_doc, "cached": False}


# ---- Opening explorer ----
# A basic in-house opening explorer sourced from StakeChess's own
# completed games (not an external database - there isn't one in this
# codebase). Queried by a comma-separated UCI move prefix; the first
# OPENING_EXPLORER_FREE_PLY ply are free, going deeper costs credits per
# query (feature key "opening_explorer_deep") - there's no persistent
# unlock here since it's a live query over changing game data, not a
# one-time compute like the review/analysis features above.

@api_router.get("/opening-explorer")
async def opening_explorer(request: Request, moves: str = ""):
    user = await get_current_user(request)

    move_list = [m.strip() for m in moves.split(",") if m.strip()] if moves else []
    ply = len(move_list)

    spend_result = None
    if ply > OPENING_EXPLORER_FREE_PLY:
        spend_result = await spend_credits(
            user["user_id"],
            "opening_explorer_deep",
            reference_id="-".join(move_list) or "start",
            metadata={"ply": ply, "moves": move_list},
        )

    # Mongo can't express "array length >= N" with a plain query filter,
    # so $expr is needed to make sure the game actually has a move at
    # index `ply` before we look at moves.{ply} below.
    query: Dict[str, Any] = {
        "status": "completed",
        "$expr": {"$gte": [{"$size": {"$ifNull": ["$moves", []]}}, ply + 1]},
    }
    for i, mv in enumerate(move_list):
        query[f"moves.{i}"] = mv

    cursor = db.games.find(
        query,
        {"_id": 0, "moves": 1, "result": 1},
    ).limit(2000)

    next_move_stats: Dict[str, Dict[str, int]] = {}
    total = 0
    async for g in cursor:
        game_moves = g.get("moves", [])
        if len(game_moves) <= ply:
            continue
        next_move = game_moves[ply]
        stats = next_move_stats.setdefault(
            next_move, {"games": 0, "white_wins": 0, "black_wins": 0, "draws": 0}
        )
        stats["games"] += 1
        total += 1
        result = g.get("result")
        if result == "white":
            stats["white_wins"] += 1
        elif result == "black":
            stats["black_wins"] += 1
        elif result == "draw":
            stats["draws"] += 1

    next_moves = [
        {
            "move": mv,
            "games": s["games"],
            "white_win_pct": round(100 * s["white_wins"] / s["games"], 1),
            "black_win_pct": round(100 * s["black_wins"] / s["games"], 1),
            "draw_pct": round(100 * s["draws"] / s["games"], 1),
        }
        for mv, s in sorted(next_move_stats.items(), key=lambda kv: -kv[1]["games"])
    ]

    return {
        "ply": ply,
        "total_games": total,
        "next_moves": next_moves,
        "free": ply <= OPENING_EXPLORER_FREE_PLY,
        "free_ply_limit": OPENING_EXPLORER_FREE_PLY,
        "spend": spend_result,
    }

# ============= WALLET ROUTES =============

@api_router.post("/wallet/deposit")
async def deposit(deposit_data: DepositRequest, request: Request):
    user = await get_current_user(request)
    
    await db.users.update_one(
        {"user_id": user["user_id"]},
        {"$inc": {f"wallet_balance.{deposit_data.currency}": deposit_data.amount}}
    )
    
    await db.transactions.insert_one({
        "tx_id": f"tx_{uuid.uuid4().hex[:12]}",
        "user_id": user["user_id"],
        "tx_type": "deposit",
        "amount": deposit_data.amount,
        "currency": deposit_data.currency,
        "status": "completed",
        "created_at": datetime.now(timezone.utc).isoformat()
    })
    
    updated_user = await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0})
    return {"success": True, "wallet_balance": updated_user.get("wallet_balance")}

@api_router.post("/wallet/withdraw")
async def withdraw(withdraw_data: WithdrawRequest, request: Request):
    user = await get_current_user(request)
    
    balance = user.get("wallet_balance", {}).get(withdraw_data.currency, 0)
    if balance < withdraw_data.amount:
        raise HTTPException(status_code=400, detail="Insufficient balance")
    
    # Deduct balance immediately (will be refunded if rejected)
    await db.users.update_one(
        {"user_id": user["user_id"]},
        {"$inc": {f"wallet_balance.{withdraw_data.currency}": -withdraw_data.amount}}
    )
    
    # Create withdrawal request
    withdrawal_id = f"wd_{uuid.uuid4().hex[:12]}"
    withdrawal = {
        "withdrawal_id": withdrawal_id,
        "tx_id": f"tx_{uuid.uuid4().hex[:12]}",
        "user_id": user["user_id"],
        "username": user["username"],
        "amount": withdraw_data.amount,
        "currency": withdraw_data.currency,
        "withdrawal_method": withdraw_data.withdrawal_method,
        "wallet_address": withdraw_data.wallet_address,
        "status": "pending",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": None,
        "confirmed_at": None,
        "admin_note": None
    }
    
    await db.withdrawals.insert_one(withdrawal)
    
    # Also create a transaction record
    await db.transactions.insert_one({
        "tx_id": withdrawal["tx_id"],
        "user_id": user["user_id"],
        "tx_type": "withdraw",
        "amount": -withdraw_data.amount,
        "currency": withdraw_data.currency,
        "status": "pending",
        "wallet_address": withdraw_data.wallet_address,
        "withdrawal_id": withdrawal_id,
        "created_at": datetime.now(timezone.utc).isoformat()
    })
    
    # Notify admins via WebSocket
    await sio.emit('new_withdrawal', {
        "withdrawal_id": withdrawal_id,
        "user_id": user["user_id"],
        "username": user["username"],
        "amount": withdraw_data.amount,
        "currency": withdraw_data.currency,
        "wallet_address": withdraw_data.wallet_address,
        "created_at": withdrawal["created_at"]
    }, room="admin_room")
    
    updated_user = await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0})
    return {
        "success": True, 
        "wallet_balance": updated_user.get("wallet_balance"),
        "withdrawal_id": withdrawal_id,
        "message": "Withdrawal request submitted. Pending admin confirmation."
    }

@api_router.get("/wallet/transactions")
async def get_transactions(request: Request):
    user = await get_current_user(request)
    
    transactions = await db.transactions.find(
        {"user_id": user["user_id"]},
        {"_id": 0}
    ).sort("created_at", -1).limit(50).to_list(50)
    
    return transactions

# ============= COMPUTER PLAY ROUTES =============

class ComputerMoveRequest(BaseModel):
    fen: str
    depth: int = 10
    analysis: bool = False
    multi_pv: int = 3

@api_router.post("/computer/move")
async def get_computer_move(move_req: ComputerMoveRequest):
    """Get best move from Stockfish for computer play"""
    book_moves = get_opening_book_moves(move_req.fen)
    if not STOCKFISH_AVAILABLE:
        # Fallback: return a random legal move using python-chess
        import chess
        board = chess.Board(move_req.fen)
        legal_moves = list(board.legal_moves)
        if not legal_moves:
            raise HTTPException(status_code=400, detail="No legal moves available")
        import random
        move = random.choice(legal_moves)
        return {
            "move": move.uci(),
            "source": "random",
            "category": "random",
            "book_move": False,
            "evaluation": None,
            "top_moves": [],
            "book_moves": book_moves,
        }
    
    try:
        # Hash halved from 128 - see _stockfish_job_slots's docstring.
        # Deliberately NOT routed through that semaphore, unlike the
        # other three sites: this is real-time gameplay (a bot move,
        # not a background review), usually much shallower/faster than
        # ANALYSIS_DEPTH, and queuing it behind a slow deep review would
        # stall active games. It still contributes to peak memory, so if
        # crashes continue after the other changes, gating this one too
        # (at the cost of bot-move latency during a concurrent review)
        # or moving to a larger instance are the next levers to pull.
        stockfish = Stockfish(path=STOCKFISH_PATH, depth=move_req.depth, parameters={"Threads": 2, "Hash": 64})
        stockfish.set_fen_position(move_req.fen)

        # Elo-targeted strength instead of the classic 0-20 Skill Level.
        # Skill Level injects blunders into the search in a way that plays
        # noticeably weaker/more erratic than its number suggests at the
        # lower end; UCI_LimitStrength + UCI_Elo asks the engine to aim
        # for an actual rating, which tracks the frontend's advertised
        # ELO per difficulty much more closely.
        if move_req.depth <= 3:
            target_elo = 800
        elif move_req.depth <= 6:
            target_elo = 1200
        elif move_req.depth <= 10:
            target_elo = 1600
        elif move_req.depth < 15:
            target_elo = 2000
        else:
            target_elo = None  # Master: full strength, no cap

        if target_elo is not None:
            stockfish.update_engine_parameters({
                "UCI_LimitStrength": "true",
                "UCI_Elo": target_elo,
            })
        else:
            stockfish.update_engine_parameters({"UCI_LimitStrength": "false"})

        best_move = stockfish.get_best_move()
        evaluation = stockfish.get_evaluation() or {}
        top_moves = []
        if move_req.multi_pv and move_req.multi_pv > 1:
            top_moves = stockfish.get_top_moves(move_req.multi_pv)
        
        if not best_move:
            raise HTTPException(status_code=400, detail="No move available")
        
        return {
            "move": best_move,
            "source": "stockfish",
            "category": "book" if best_move in book_moves else "stockfish",
            "book_move": best_move in book_moves,
            "evaluation": evaluation,
            "top_moves": top_moves,
            "book_moves": book_moves,
            "depth": move_req.depth,
            "target_elo": target_elo,  # None means full strength (Master)
        }
    except Exception as e:
        logger.error(f"Stockfish error: {e}")
        import chess
        board = chess.Board(move_req.fen)
        legal_moves = list(board.legal_moves)
        if not legal_moves:
            raise HTTPException(status_code=400, detail="No legal moves available")
        import random
        move = random.choice(legal_moves)
        return {
            "move": move.uci(),
            "source": "random_fallback",
            "evaluation": None,
            "top_moves": [],
            "book_moves": book_moves,
        }

# ============= LEADERBOARD ROUTES =============

@api_router.get("/leaderboard")
async def get_leaderboard(sort_by: str = "rating", limit: int = 20):
    sort_field = "rating"
    if sort_by == "wins":
        sort_field = "wins"
    elif sort_by == "games":
        sort_field = "games_played"
    
    users = await db.users.find(
        {"is_banned": {"$ne": True}},
        {"_id": 0, "password": 0}
    ).sort(sort_field, -1).limit(limit).to_list(limit)
    
    return users

# ============= USER ROUTES =============

@api_router.get("/users/{user_id}", response_model=UserResponse)
async def get_user(user_id: str):
    user = await db.users.find_one({"user_id": user_id}, {"_id": 0, "password": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return UserResponse(**user)


@api_router.put("/users/{user_id}/settings")
async def update_user_settings(user_id: str, request: Request):
    user = await get_current_user(request)
    # Only allow users to update their own settings (or admin)
    if user_id != user["user_id"] and not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Not authorized")

    body = await request.json()
    # Accept challenge preference settings
    settings = {}
    if "min_challenge_rating" in body:
        settings["min_challenge_rating"] = int(body["min_challenge_rating"])
    if "max_challenge_rating" in body:
        settings["max_challenge_rating"] = int(body["max_challenge_rating"])
    if "allow_any_rating" in body:
        settings["allow_any_rating"] = bool(body["allow_any_rating"])
    board_preferences = None
    if "board_preferences" in body and isinstance(body["board_preferences"], dict):
        board_preferences = _validate_board_preferences(body["board_preferences"])

    # These are top-level fields on the user document (and on UserResponse),
    # not part of challenge_preferences - keep them out of `settings` so they
    # don't get nested where nothing actually reads them from.
    top_level_updates = {}
    if "allow_spectators" in body:
        top_level_updates["allow_spectators"] = bool(body["allow_spectators"])
    if "allow_chat_broadcast" in body:
        top_level_updates["allow_chat_broadcast"] = bool(body["allow_chat_broadcast"])
    if "timezone" in body:
        tz_name = (body.get("timezone") or "").strip()
        if tz_name:
            try:
                ZoneInfo(tz_name)
            except (ZoneInfoNotFoundError, ValueError):
                raise HTTPException(status_code=400, detail=f"Unknown timezone '{tz_name}'")
            top_level_updates["timezone"] = tz_name
        else:
            top_level_updates["timezone"] = None

    if not settings and board_preferences is None and not top_level_updates:
        raise HTTPException(status_code=400, detail="No valid settings provided")

    update_data = {}
    if settings:
        update_data["challenge_preferences"] = settings
    if board_preferences is not None:
        update_data["board_preferences"] = board_preferences
    if top_level_updates:
        update_data.update(top_level_updates)

    await db.users.update_one({"user_id": user_id}, {"$set": update_data})
    updated = await db.users.find_one({"user_id": user_id}, {"_id": 0, "password": 0})
    return UserResponse(**updated)

@api_router.put("/users/{user_id}/profile")
async def update_user_profile(user_id: str, request: Request):
    """Update editable profile fields (currently username)."""
    user = await get_current_user(request)
    if user_id != user["user_id"] and not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Not authorized")

    body = await request.json()
    updates = {}

    if "username" in body:
        username = (body.get("username") or "").strip()
        if len(username) < 3 or len(username) > 20:
            raise HTTPException(status_code=400, detail="Username must be 3-20 characters")
        if not re.fullmatch(r"[A-Za-z0-9_]+", username):
            raise HTTPException(
                status_code=400,
                detail="Username can only contain letters, numbers and underscores",
            )
        existing = await db.users.find_one({"username": username, "user_id": {"$ne": user_id}})
        if existing:
            raise HTTPException(status_code=400, detail="That username is already taken")
        updates["username"] = username

    if "fide_id" in body:
        updates["fide_id"] = (body.get("fide_id") or "").strip()
    if "country" in body:
        updates["country"] = (body.get("country") or "").strip()
    if "team_club" in body:
        updates["team_club"] = (body.get("team_club") or "").strip()
    if "chess_title" in body:
        updates["chess_title"] = (body.get("chess_title") or "").strip()
    if "chess_bio" in body:
        updates["chess_bio"] = (body.get("chess_bio") or "").strip()
    # board_preferences is intentionally NOT accepted here - PUT /users/{id}/settings
    # is the only endpoint that writes it (see Profile.jsx "Board appearance" card).
    # This used to also accept it, which let the old "Chess profile" card save a
    # picked theme/color that then got silently overwritten by whatever
    # /settings last wrote, since both were writing the same field.

    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields provided")

    await db.users.update_one({"user_id": user_id}, {"$set": updates})
    updated = await db.users.find_one({"user_id": user_id}, {"_id": 0, "password": 0})
    return UserResponse(**updated)


@api_router.put("/users/{user_id}/password")
async def change_user_password(user_id: str, request: Request):
    """Change password. Requires the current password unless an admin is acting."""
    user = await get_current_user(request)
    is_self = user_id == user["user_id"]
    if not is_self and not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Not authorized")

    body = await request.json()
    new_password = body.get("new_password") or ""
    if len(new_password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")

    target = await db.users.find_one({"user_id": user_id})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    # OAuth-only accounts have no local password to verify against.
    has_password = bool(target.get("password"))
    if is_self and has_password:
        current_password = body.get("current_password") or ""
        if not verify_password(current_password, target["password"]):
            raise HTTPException(status_code=400, detail="Current password is incorrect")

    await db.users.update_one(
        {"user_id": user_id},
        {"$set": {"password": get_password_hash(new_password)}},
    )
    return {"success": True, "message": "Password updated"}


@api_router.put("/users/{user_id}/avatar")
async def update_user_avatar(user_id: str, request: Request):
    """Store a profile picture as a base64 data URL.

    Kept as a JSON data-URL rather than multipart file storage so it works the
    same on ephemeral hosts (Render/Vercel) where a local uploads dir wouldn't
    survive a restart. Capped to keep documents well under Mongo's 16MB limit.
    """
    user = await get_current_user(request)
    if user_id != user["user_id"] and not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Not authorized")

    body = await request.json()
    picture = body.get("picture")

    if picture in (None, ""):
        await db.users.update_one({"user_id": user_id}, {"$set": {"picture": None}})
        updated = await db.users.find_one({"user_id": user_id}, {"_id": 0, "password": 0})
        return UserResponse(**updated)

    if not isinstance(picture, str) or not picture.startswith("data:image/"):
        raise HTTPException(status_code=400, detail="Picture must be an image data URL")
    if len(picture) > 3_000_000:
        raise HTTPException(status_code=400, detail="Image is too large (max ~2MB)")

    await db.users.update_one({"user_id": user_id}, {"$set": {"picture": picture}})
    updated = await db.users.find_one({"user_id": user_id}, {"_id": 0, "password": 0})
    return UserResponse(**updated)


@api_router.get("/users/{user_id}/games")
async def get_user_games(user_id: str, limit: int = 20):
    games = await db.games.find(
        {
            "$or": [
                {"white_player.user_id": user_id},
                {"black_player.user_id": user_id}
            ]
        },
        {"_id": 0}
    ).sort("created_at", -1).limit(limit).to_list(limit)
    
    return games

# ============= ADMIN ROUTES =============

@api_router.get("/admin/stats")
async def admin_stats(request: Request):
    await get_admin_user(request)
    
    total_users = await db.users.count_documents({})
    total_games = await db.games.count_documents({})
    active_games = await db.games.count_documents({"status": "active"})
    flagged_players = await db.users.count_documents({"is_flagged": True})
    banned_players = await db.users.count_documents({"is_banned": True})
    
    revenue_docs = await db.platform_revenue.find({}, {"_id": 0}).to_list(1000)
    total_revenue = {}
    for doc in revenue_docs:
        currency = doc.get("currency", "USDT")
        total_revenue[currency] = total_revenue.get(currency, 0) + doc.get("amount", 0)
    
    active_tournaments = await db.tournaments.count_documents({"status": "active"})
    
    return {
        "total_users": total_users,
        "total_games": total_games,
        "active_games": active_games,
        "total_revenue": total_revenue,
        "flagged_players": flagged_players,
        "banned_players": banned_players,
        "active_tournaments": active_tournaments
    }

@api_router.get("/admin/users")
async def admin_list_users(request: Request, skip: int = 0, limit: int = 50):
    await get_admin_user(request)
    
    users = await db.users.find({}, {"_id": 0, "password": 0}).skip(skip).limit(limit).to_list(limit)
    return users

@api_router.get("/admin/flagged-players")
async def admin_flagged_players(request: Request):
    await get_admin_user(request)
    
    flags = await db.anticheat_flags.find({"status": "pending"}, {"_id": 0}).sort("created_at", -1).to_list(50)
    
    result = []
    for flag in flags:
        user = await db.users.find_one({"user_id": flag["user_id"]}, {"_id": 0, "password": 0})
        if user:
            flag["user"] = user
        result.append(flag)
    
    return result

@api_router.post("/admin/analyze-player/{user_id}")
async def admin_analyze_player(user_id: str, request: Request):
    """Manually trigger Stockfish-based anti-cheat analysis for a player"""
    await get_admin_user(request)
    
    # Check if user exists
    user = await db.users.find_one({"user_id": user_id})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    try:
        analysis = await analyze_player_behavior(user_id)
        return {
            "success": True,
            "user_id": user_id,
            "username": user.get("username"),
            "analysis": analysis
        }
    except Exception as e:
        logger.error(f"Analysis failed for {user_id}: {e}")
        return {
            "success": False,
            "user_id": user_id,
            "error": str(e)
        }

@api_router.put("/admin/users/{user_id}/ban")
async def admin_ban_user(user_id: str, request: Request):
    await get_admin_user(request)
    
    await db.users.update_one(
        {"user_id": user_id},
        {"$set": {"is_banned": True}}
    )
    
    return {"success": True}

@api_router.put("/admin/users/{user_id}/unban")
async def admin_unban_user(user_id: str, request: Request):
    await get_admin_user(request)
    
    await db.users.update_one(
        {"user_id": user_id},
        {"$set": {"is_banned": False, "is_flagged": False}}
    )
    
    # Clear flags
    await db.anticheat_flags.update_many(
        {"user_id": user_id},
        {"$set": {"status": "cleared"}}
    )
    
    return {"success": True}

@api_router.put("/admin/users/{user_id}/clear-flag")
async def admin_clear_flag(user_id: str, request: Request):
    await get_admin_user(request)
    
    await db.users.update_one(
        {"user_id": user_id},
        {"$set": {"is_flagged": False}}
    )
    
    await db.anticheat_flags.update_many(
        {"user_id": user_id, "status": "pending"},
        {"$set": {"status": "cleared"}}
    )
    
    return {"success": True}

@api_router.put("/admin/users/{user_id}/balance")
async def admin_adjust_balance(user_id: str, request: Request):
    await get_admin_user(request)
    body = await request.json()
    
    currency = body.get("currency", "USDT")
    amount = body.get("amount", 0)
    
    await db.users.update_one(
        {"user_id": user_id},
        {"$inc": {f"wallet_balance.{currency}": amount}}
    )
    
    return {"success": True}

@api_router.get("/admin/settings")
async def admin_get_settings(request: Request):
    await get_admin_user(request)
    
    settings = await db.settings.find_one({"type": "platform"}, {"_id": 0})
    if not settings:
        settings = {
            "type": "platform",
            "arbiter_fee": 0.02,
            "min_stake": 1,
            "max_stake": 1000,
            "puzzle_base_reward": 15,
            "puzzle_reward_scale": 3,
            "puzzle_difficulty_count": 10,
        }
        await db.settings.insert_one(settings)
    
    return settings

@api_router.put("/admin/settings")
async def admin_update_settings(settings: AdminSettingsUpdate, request: Request):
    await get_admin_user(request)
    
    update_data = {k: v for k, v in settings.model_dump().items() if v is not None}
    
    await db.settings.update_one(
        {"type": "platform"},
        {"$set": update_data},
        upsert=True
    )
    
    return {"success": True}

def _puzzle_natural_difficulty(solved_count: int, difficulty_count: int) -> int:
    """The difficulty tier a user has organically earned through solving
    puzzles - shared by /puzzles/next and /puzzles/progress so the two
    can never disagree. Extracted verbatim from the original inline
    formula in both places, not changed."""
    difficulty_count = max(1, difficulty_count)
    return min(difficulty_count, max(1, solved_count // max(1, 10000 // difficulty_count) + 1))


def _today_str_for_timezone(tz_name: Optional[str]) -> str:
    """Today's date (YYYY-MM-DD) in the given IANA timezone, falling back
    to UTC if tz_name is unset or invalid. Used so daily-reset budgets
    (Phase 4b puzzle retries/skips) reset at the user's local midnight,
    not a fixed UTC midnight - a user's timezone is set via
    PUT /users/{id}/settings and validated with zoneinfo there."""
    if tz_name:
        try:
            return datetime.now(ZoneInfo(tz_name)).strftime("%Y-%m-%d")
        except (ZoneInfoNotFoundError, ValueError):
            pass
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


# ============= PHASE 4b: PUZZLES & PRACTICE =============
# Feature keys introduced in this phase (price via
# PUT /admin/credit-feature-costs/{feature_key}, same as Phase 4a):
#   - "puzzle_retry"  extra guess after PUZZLE_FREE_DAILY_MISSES wrong
#                      guesses have already been used today
#   - "puzzle_skip"   extra puzzle skip after PUZZLE_FREE_DAILY_SKIPS free
#                      skips have already been used today
#   - "puzzle_pack"   one-time per-user unlock of a difficulty tier above
#                      the one the user has naturally earned via solved_count
#
# "Extra lives/retries" and "skip tokens" are both modeled as a daily free
# budget (resets at the user's local midnight - see _today_str_for_timezone -
# falling back to UTC if they haven't set a timezone) rather than a
# persistent unlock, since they're consumable actions, not a permanent
# purchase - unlike "puzzle_pack", which behaves like Phase 4a's unlock
# features (buy once, keep forever) since the spec frames packs as
# something you own.
PUZZLE_FREE_DAILY_MISSES = 5
PUZZLE_FREE_DAILY_SKIPS = 5


async def _consume_daily_budget(user: dict, budget_key: str, free_limit: int, feature_key: str, reference_id: str, collection=None) -> dict:
    """Shared daily-free-then-paid budget. Originally built for puzzle
    retries/skips (`collection` defaults to db.puzzle_progress so those
    existing call sites are unaffected); Phase 4c reuses it for extra
    challenge invites via a different collection so the two budgets never
    collide. Stored as f"{budget_key}_today" / f"{budget_key}_date" on
    whatever collection is passed, reset whenever the stored date isn't
    "today" in the user's own timezone (user["timezone"], falling back to
    UTC if unset).

    Call this BEFORE the action it gates. If the day's free budget is
    already used up, it charges `feature_key` credits - raising
    HTTPException(402) exactly like spend_credits() does - before letting
    the caller proceed. It does NOT increment the counter itself; call
    _record_daily_usage after the gated action actually happens, so a
    request that 402s here never counts against the budget.
    """
    collection = db.puzzle_progress if collection is None else collection
    user_id = user["user_id"]
    today = _today_str_for_timezone(user.get("timezone"))
    progress = await collection.find_one({"user_id": user_id}, {"_id": 0}) or {}
    used_today = progress.get(f"{budget_key}_today", 0) if progress.get(f"{budget_key}_date") == today else 0

    if used_today < free_limit:
        return {"paid": False, "used_today": used_today, "free_limit": free_limit}

    spend_result = await spend_credits(user_id, feature_key, reference_id=reference_id, metadata={"budget_key": budget_key})
    return {"paid": True, "used_today": used_today, "free_limit": free_limit, "spend": spend_result}


async def _record_daily_usage(user: dict, budget_key: str, collection=None) -> None:
    """Increments today's usage counter for _consume_daily_budget - call
    only after the gated action actually happened. Uses the same per-user
    localized "today" as _consume_daily_budget so the two never disagree
    about which day a given action falls on. `collection` must match
    whatever was passed to the corresponding _consume_daily_budget call."""
    collection = db.puzzle_progress if collection is None else collection
    user_id = user["user_id"]
    today = _today_str_for_timezone(user.get("timezone"))
    progress = await collection.find_one({"user_id": user_id}, {"_id": 0}) or {}
    used_today = progress.get(f"{budget_key}_today", 0) if progress.get(f"{budget_key}_date") == today else 0
    await collection.update_one(
        {"user_id": user_id},
        {"$set": {f"{budget_key}_date": today, f"{budget_key}_today": used_today + 1}},
        upsert=True,
    )


@api_router.get("/puzzles/next", response_model=PuzzleResponse)
async def get_next_puzzle(request: Request, difficulty: Optional[int] = None):
    user = await get_current_user(request)
    settings = await db.settings.find_one({"type": "platform"}, {"_id": 0}) or {}
    await seed_puzzles_if_needed(settings)

    progress = await db.puzzle_progress.find_one({"user_id": user["user_id"]}) or {}
    solved_count = progress.get("solved_count", 0)
    difficulty_count = max(1, settings.get("puzzle_difficulty_count", 10))
    natural_difficulty = _puzzle_natural_difficulty(solved_count, difficulty_count)

    # Phase 4b: "themed puzzle packs" simplified to paid access to a
    # difficulty tier above the one the user has naturally earned yet.
    # Tiers at or below natural_difficulty are always free (already
    # earned by solving). Requesting a tier above it is a one-time
    # per-user unlock, same claim-then-charge pattern as Phase 4a.
    if difficulty is not None:
        if difficulty < 1 or difficulty > difficulty_count:
            raise HTTPException(status_code=400, detail=f"difficulty must be between 1 and {difficulty_count}")
        if difficulty > natural_difficulty:
            await _claim_unlock(
                db.puzzle_pack_unlocks, user["user_id"], {"difficulty": difficulty},
                "puzzle_pack", reference_id=str(difficulty),
            )
        selected_difficulty = difficulty
    else:
        selected_difficulty = natural_difficulty

    # Phase 4b: skip tokens. Requesting a new puzzle while the user's most
    # recent attempt is still unsolved counts as skipping it. The very
    # first puzzle a user ever requests, or requesting a new one right
    # after solving the last, is never a skip.
    last_attempt = await db.puzzle_attempts.find_one(
        {"user_id": user["user_id"]}, {"_id": 0}, sort=[("created_at", -1)]
    )
    is_skip = bool(last_attempt) and not last_attempt.get("completed")
    if is_skip:
        await _consume_daily_budget(user, "skips", PUZZLE_FREE_DAILY_SKIPS, "puzzle_skip", reference_id=last_attempt["attempt_id"])

    total_matching = await db.puzzles.count_documents({"difficulty": selected_difficulty})
    if total_matching == 0:
        raise HTTPException(status_code=404, detail="No puzzles available for this difficulty")

    selected_index = random.randrange(total_matching)
    puzzle_cursor = db.puzzles.find({"difficulty": selected_difficulty}, {"_id": 0}).skip(selected_index).limit(1)
    puzzles = await puzzle_cursor.to_list(1)
    if not puzzles:
        raise HTTPException(status_code=404, detail="No puzzle found")

    puzzle_doc = await normalize_puzzle_doc(puzzles[0], settings)

    # Start a fresh solving session for this puzzle, keyed by a random
    # attempt_id rather than puzzle_id. Puzzle docs are drawn randomly by
    # difficulty and can repeat across requests/tabs, so tracking progress
    # against puzzle_id would let a stale attempt on the same puzzle
    # collide with a brand-new one. attempt_id keeps every "play through"
    # of a puzzle independent.
    attempt_id = f"attempt_{uuid.uuid4().hex[:16]}"
    ply_index = 0
    display_fen = puzzle_doc["fen"]
    if not puzzle_doc.get("player_moves_first", True):
        # Scaffold for puzzles whose first ply is an opponent "setup" move
        # rather than something the player must find (see requirement of
        # detecting whose move comes first). None of the current templates
        # need this, but a future puzzle doc can set
        # player_moves_first=False and player_fen to the position right
        # after that forced setup move, and it will be auto-consumed here
        # instead of ever being shown to the player as a move to guess.
        ply_index = 1
        display_fen = puzzle_doc.get("player_fen", display_fen)

    await db.puzzle_attempts.insert_one({
        "attempt_id": attempt_id,
        "user_id": user["user_id"],
        "puzzle_id": puzzle_doc["puzzle_id"],
        "ply_index": ply_index,
        "completed": False,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })

    # Only record the skip as "used" once a replacement puzzle has
    # actually been served - a request that 402'd above never gets here.
    if is_skip:
        await _record_daily_usage(user, "skips")

    response_doc = dict(puzzle_doc)
    response_doc["fen"] = display_fen
    response_doc["attempt_id"] = attempt_id
    return PuzzleResponse(**response_doc)


@api_router.get("/puzzles/packs")
async def list_puzzle_packs(request: Request):
    """Difficulty tiers available as Phase 4b 'packs', with unlock status
    and price, so the frontend can show a pack-browsing screen instead of
    the user discovering paid tiers only by hitting a 402."""
    user = await get_current_user(request)
    settings = await db.settings.find_one({"type": "platform"}, {"_id": 0}) or {}
    difficulty_count = max(1, settings.get("puzzle_difficulty_count", 10))

    progress = await db.puzzle_progress.find_one({"user_id": user["user_id"]}, {"_id": 0}) or {}
    natural_difficulty = _puzzle_natural_difficulty(progress.get("solved_count", 0), difficulty_count)

    unlocked_tiers = {
        doc["difficulty"]
        async for doc in db.puzzle_pack_unlocks.find({"user_id": user["user_id"]}, {"_id": 0, "difficulty": 1})
    }
    cost = await get_credit_feature_cost("puzzle_pack")

    packs = []
    for tier in range(1, difficulty_count + 1):
        earned = tier <= natural_difficulty
        packs.append({
            "difficulty": tier,
            "unlocked": earned or tier in unlocked_tiers,
            "earned": earned,
            "cost": None if earned else cost,
        })
    return {"packs": packs, "natural_difficulty": natural_difficulty}


@api_router.get("/puzzles/progress", response_model=PuzzleProgressResponse)
async def get_puzzle_progress(request: Request):
    user = await get_current_user(request)
    settings = await db.settings.find_one({"type": "platform"}, {"_id": 0}) or {}
    progress = await db.puzzle_progress.find_one({"user_id": user["user_id"]}) or {}
    solved_count = progress.get("solved_count", 0)
    earned_rating = progress.get("earned_rating", 0)
    difficulty_count = max(1, settings.get("puzzle_difficulty_count", 10))
    current_difficulty = _puzzle_natural_difficulty(solved_count, difficulty_count)
    recent = progress.get("recent_solved", [])[-10:]

    return PuzzleProgressResponse(
        solved_count=solved_count,
        earned_rating=earned_rating,
        current_difficulty=current_difficulty,
        recent_solved=recent
    )


@api_router.get("/puzzles/budget-status")
async def get_puzzle_budget_status(request: Request):
    """Phase 5: read-only preview of today's free retry/skip budgets and
    what the next one beyond them would cost - lets the frontend show an
    ambient 'X free skips left today' instead of the user only learning
    the price from a 402 toast after they've already run out. Same
    read-without-charging shape as get_pgn_import_status. Never
    increments or charges."""
    user = await get_current_user(request)
    today = _today_str_for_timezone(user.get("timezone"))
    progress = await db.puzzle_progress.find_one({"user_id": user["user_id"]}, {"_id": 0}) or {}

    def _status(budget_key, free_limit):
        used_today = progress.get(f"{budget_key}_today", 0) if progress.get(f"{budget_key}_date") == today else 0
        return {"used_today": used_today, "free_limit": free_limit, "remaining_free": max(0, free_limit - used_today)}

    retries = _status("misses", PUZZLE_FREE_DAILY_MISSES)
    skips = _status("skips", PUZZLE_FREE_DAILY_SKIPS)
    retries["cost"] = await get_credit_feature_cost("puzzle_retry")
    skips["cost"] = await get_credit_feature_cost("puzzle_skip")
    return {"retries": retries, "skips": skips}

@api_router.post("/puzzles/attempts/{attempt_id}/move")
async def submit_puzzle_move(attempt_id: str, move_request: PuzzleMoveRequest, request: Request):
    """Validate exactly one ply of a puzzle's move sequence.

    This is deliberately per-move, not per-puzzle: the client sends one SAN
    move every time the player drops a piece, the server checks it against
    the single next expected ply (tracked server-side via the attempt, not
    trusted from the client), and - if correct - auto-plays the opponent's
    scripted reply and hands back only that one move. The remaining
    solution is never sent to the client, so nothing beyond "is this one
    move right" is ever exposed.
    """
    user = await get_current_user(request)

    attempt = await db.puzzle_attempts.find_one(
        {"attempt_id": attempt_id, "user_id": user["user_id"]}, {"_id": 0}
    )
    if not attempt:
        raise HTTPException(status_code=404, detail="Puzzle attempt not found")
    if attempt.get("completed"):
        return {"correct": True, "puzzle_complete": True, "message": "This puzzle was already solved."}

    puzzle = await db.puzzles.find_one({"puzzle_id": attempt["puzzle_id"]}, {"_id": 0})
    if not puzzle:
        raise HTTPException(status_code=404, detail="Puzzle not found")

    solution = puzzle.get("solution") or []
    idx = attempt.get("ply_index", 0)
    if not isinstance(solution, list) or idx >= len(solution):
        raise HTTPException(status_code=400, detail="Puzzle has no more moves to solve")

    def normalize(move: str) -> str:
        return (move or "").strip().upper().replace(" ", "")

    submitted = normalize(move_request.move)
    expected = normalize(solution[idx])

    if submitted != expected:
        # Phase 4b: extra retries after the daily free ones run out. The
        # daily budget only counts wrong guesses (see PUZZLE_FREE_DAILY_MISSES) -
        # this consumes a "life" for a wrong answer, or charges credits if
        # the day's free lives are already spent. Raises HTTPException(402)
        # if the user is out of free retries and can't afford another.
        budget_result = await _consume_daily_budget(user, "misses", PUZZLE_FREE_DAILY_MISSES, "puzzle_retry", reference_id=attempt_id)
        await _record_daily_usage(user, "misses")

        # Wrong guess: ply_index does not advance and the expected move is
        # never revealed, so a wrong answer teaches the client nothing
        # about the real solution beyond "not that one".
        message = "Incorrect. Try one of the hints or review the position."
        if budget_result["paid"]:
            message = f"Incorrect (out of free retries today - {budget_result['spend']['cost']} credits spent for this attempt)."
        return {
            "correct": False,
            "puzzle_complete": False,
            "message": message,
            "retry_charged": budget_result["paid"],
        }

    idx += 1
    opponent_move = None
    if idx < len(solution):
        # The next ply in the line always belongs to the opponent - it is
        # auto-played and revealed one move at a time, only after the
        # player has actually earned it.
        opponent_move = solution[idx]
        idx += 1

    puzzle_complete = idx >= len(solution)

    await db.puzzle_attempts.update_one(
        {"attempt_id": attempt_id},
        {"$set": {"ply_index": idx, "completed": puzzle_complete}}
    )

    if not puzzle_complete:
        return {
            "correct": True,
            "puzzle_complete": False,
            "opponent_move": opponent_move,
            "message": f"Correct! {opponent_move} played automatically - find the next move." if opponent_move else "Correct! Find the next move.",
        }

    # Full sequence solved - award rating exactly once for this attempt.
    reward = int(puzzle.get("reward", 0))
    progress = await db.puzzle_progress.find_one({"user_id": user["user_id"]}) or {}
    solved_count = progress.get("solved_count", 0) + 1
    earned_rating = progress.get("earned_rating", 0) + reward
    recent = progress.get("recent_solved", [])
    recent.append({
        "puzzle_id": puzzle["puzzle_id"],
        "title": puzzle.get("title"),
        "difficulty": puzzle.get("difficulty"),
        "reward": reward,
        "solved_at": datetime.now(timezone.utc).isoformat(),
    })
    recent = recent[-20:]

    await db.puzzle_progress.update_one(
        {"user_id": user["user_id"]},
        {"$set": {
            "solved_count": solved_count,
            "earned_rating": earned_rating,
            "recent_solved": recent
        }},
        upsert=True
    )

    await db.users.update_one(
        {"user_id": user["user_id"]},
        {"$inc": {"rating": reward}}
    )

    if reward > 0:
        await sio.emit("puzzle_solved", {
            "user_id": user["user_id"],
            "username": user.get("username"),
            "reward": reward,
            "puzzle_id": puzzle["puzzle_id"],
        }, room=f"user_{user['user_id']}")

    return {
        "correct": True,
        "puzzle_complete": True,
        "opponent_move": opponent_move,
        "reward": reward,
        "new_rating": user.get("rating", 1200) + reward,
        "message": f"Puzzle solved! You earned {reward} rating points."
    }

@api_router.get("/admin/puzzles")
async def admin_list_puzzles(request: Request):
    await get_admin_user(request)
    limit = int(request.query_params.get("limit", 50))
    puzzle_list = await db.puzzles.find({}, {"_id": 0}).sort("difficulty", 1).limit(limit).to_list(limit)
    count = await db.puzzles.count_documents({})
    return {"count": count, "puzzles": puzzle_list}

@api_router.post("/admin/puzzles/seed")
async def admin_seed_puzzles(request: Request):
    await get_admin_user(request)
    force_repair = request.query_params.get("force_repair", "").lower() in ("1", "true", "yes")
    settings = await db.settings.find_one({"type": "platform"}, {"_id": 0}) or {}
    repaired = await seed_puzzles_if_needed(settings, force_repair=force_repair)
    count = await db.puzzles.count_documents({})
    return {"success": True, "count": count, "repaired": repaired}

@api_router.get("/admin/security-alerts")
async def admin_security_alerts(request: Request):
    await get_admin_user(request)
    
    alerts = await db.security_alerts.find({}, {"_id": 0}).sort("created_at", -1).limit(50).to_list(50)
    return alerts

# ============= PHASE 4d: STUDY & CONTENT =============
# Feature key introduced in this phase (price via
# PUT /admin/credit-feature-costs/{feature_key}, same as 4a/4b/4c):
#   - "pgn_import_extra"  one imported PGN beyond the free monthly cap
#
# Scope note: the other two Phase 4d items from the spec - "premium/curated
# studies from titled players" and "opening trainer courses" - are
# intentionally NOT gated here. Neither has a real feature behind it yet:
# studies.js is 12 generic YouTube-search-query entries with no curator/
# titled-player attribution or premium flag, and there is no opening-trainer
# page, route, or data model anywhere in the app. Gating either now would
# mean inventing the underlying feature, not wiring credits onto an
# existing one, so both are deferred until that product work exists. Only
# the PGN-import cap is implemented below.
#
# "Import" is defined as a successful parse via POST /pgn/import - the
# frontend calls this once ImportPGN.jsx has parsed a PGN into a valid game
# (see handleParse), not on every keystroke/attempt. Modeled as a
# calendar-month free budget (resets on the user's local 1st of the month,
# mirroring _today_str_for_timezone's per-user-timezone approach from Phase
# 4b) rather than a permanent unlock, since importing is a repeatable
# consumable action like puzzle retries/skips, not a one-time purchase like
# puzzle_pack.
PGN_FREE_MONTHLY_IMPORTS = 5


def _current_month_str_for_timezone(tz_name: Optional[str]) -> str:
    """This month (YYYY-MM) in the given IANA timezone, falling back to UTC
    if tz_name is unset or invalid. Same fallback behavior as
    _today_str_for_timezone, just month-grained instead of day-grained."""
    if tz_name:
        try:
            return datetime.now(ZoneInfo(tz_name)).strftime("%Y-%m")
        except (ZoneInfoNotFoundError, ValueError):
            pass
    return datetime.now(timezone.utc).strftime("%Y-%m")


async def _consume_monthly_budget(user: dict, budget_key: str, free_limit: int, feature_key: str, reference_id: str, collection=None) -> dict:
    """Monthly counterpart to Phase 4b's _consume_daily_budget - same
    free-then-paid shape, just keyed on the user's current calendar month
    (f"{budget_key}_month" / f"{budget_key}_count") instead of a day.

    Call this BEFORE the action it gates. If this month's free budget is
    already used up, it charges `feature_key` credits - raising
    HTTPException(402) exactly like spend_credits() does - before letting
    the caller proceed. It does NOT increment the counter itself; call
    _record_monthly_usage after the gated action actually happens, so a
    request that 402s here never counts against the budget.
    """
    user_id = user["user_id"]
    this_month = _current_month_str_for_timezone(user.get("timezone"))
    progress = await collection.find_one({"user_id": user_id}, {"_id": 0}) or {}
    used_this_month = progress.get(f"{budget_key}_count", 0) if progress.get(f"{budget_key}_month") == this_month else 0

    if used_this_month < free_limit:
        return {"paid": False, "used_this_month": used_this_month, "free_limit": free_limit}

    spend_result = await spend_credits(user_id, feature_key, reference_id=reference_id, metadata={"budget_key": budget_key})
    return {"paid": True, "used_this_month": used_this_month, "free_limit": free_limit, "spend": spend_result}


async def _record_monthly_usage(user: dict, budget_key: str, collection=None) -> None:
    """Increments this month's usage counter for _consume_monthly_budget -
    call only after the gated action actually happened. Uses the same
    per-user localized "this month" as _consume_monthly_budget so the two
    never disagree about which month a given action falls in."""
    user_id = user["user_id"]
    this_month = _current_month_str_for_timezone(user.get("timezone"))
    progress = await collection.find_one({"user_id": user_id}, {"_id": 0}) or {}
    used_this_month = progress.get(f"{budget_key}_count", 0) if progress.get(f"{budget_key}_month") == this_month else 0
    await collection.update_one(
        {"user_id": user_id},
        {"$set": {f"{budget_key}_month": this_month, f"{budget_key}_count": used_this_month + 1}},
        upsert=True,
    )


@api_router.post("/pgn/import")
async def import_pgn(import_data: PGNImportRequest, request: Request):
    """Record one PGN import against the user's free monthly cap, charging
    `pgn_import_extra` credits once that cap is used up this month. Call
    this after ImportPGN.jsx has successfully parsed a PGN, not before -
    a PGN that fails to parse was never actually imported and shouldn't
    cost anything or count against the cap.

    Raises HTTPException(402) via spend_credits() (detail.error ==
    "insufficient_credits") if the free cap is used up and the user can't
    afford pgn_import_extra - the frontend should route that into the
    Buy Credits flow like every other gated feature, not just error out.
    """
    user = await get_current_user(request)
    reference_id = import_data.reference_id or str(uuid.uuid4())

    budget_result = await _consume_monthly_budget(
        user,
        "imports",
        PGN_FREE_MONTHLY_IMPORTS,
        "pgn_import_extra",
        reference_id=reference_id,
        collection=db.pgn_import_usage,
    )
    await _record_monthly_usage(user, "imports", collection=db.pgn_import_usage)

    return {
        "success": True,
        "paid": budget_result["paid"],
        "used_this_month": budget_result["used_this_month"] + 1,
        "free_limit": budget_result["free_limit"],
        "credits_charged": budget_result["spend"]["cost"] if budget_result["paid"] else 0,
        "credits_balance": budget_result["spend"]["credits_balance"] if budget_result["paid"] else None,
    }


@api_router.get("/pgn/import/status")
async def get_pgn_import_status(request: Request):
    """Read-only - lets the frontend show 'X of Y free imports left this
    month' before the user commits to importing, same spirit as Phase 5's
    'show cost before the user commits'. Never charges or increments."""
    user = await get_current_user(request)
    this_month = _current_month_str_for_timezone(user.get("timezone"))
    progress = await db.pgn_import_usage.find_one({"user_id": user["user_id"]}, {"_id": 0}) or {}
    used_this_month = progress.get("imports_count", 0) if progress.get("imports_month") == this_month else 0
    cost = await get_credit_feature_cost("pgn_import_extra")
    return {
        "used_this_month": used_this_month,
        "free_limit": PGN_FREE_MONTHLY_IMPORTS,
        "remaining_free": max(0, PGN_FREE_MONTHLY_IMPORTS - used_this_month),
        "extra_import_cost": cost,
    }


@api_router.get("/credits/feature-costs/{feature_key}")
async def get_feature_cost_public(feature_key: str, request: Request):
    """Phase 5: generic 'show its cost before the user commits' lookup for
    ANY gated feature - a lightweight companion to spend_credits() so a new
    gated action never has to grow its own bespoke cost-preview endpoint
    (Phase 4a-4d each did this ad hoc via /puzzles/packs,
    /pgn/import/status, etc; this is the reusable version for Phase 4e and
    beyond). Auth-only, same as every other /credits/* endpoint - cost
    numbers aren't sensitive, but there's no reason to expose this
    unauthenticated either. Returns cost: None for an unpriced feature_key
    rather than 500ing, since "not priced yet" is a valid answer for a
    preview call (unlike spend_credits(), which must hard-fail if it were
    ever asked to actually charge an unpriced feature)."""
    await get_current_user(request)
    cost = await get_credit_feature_cost(feature_key)
    return {"feature_key": feature_key, "cost": cost}


# ============= PHASE 4e: UTILITY =============
# Feature keys introduced in this phase (price via
# PUT /admin/credit-feature-costs/{feature_key}, same as 4a/4b/4c/4d):
#   - "takeback_token"      undo your own last move
#   - "extra_time"          add EXTRA_TIME_SECONDS to your own clock
#   - "custom_clock_preset" save one custom time control on the standalone
#                            Chess Clock beyond CUSTOM_CLOCK_PRESET_FREE_LIMIT
#
# Casual-only scope note: the spec's locked decision is "casual games
# only, structurally impossible in a staked game" - literally
# stake_amount == 0, the same field Phase 4c's rematch_token already
# gates on. takeback_token and extra_time both use that same check and
# only that check, per explicit confirmation: tournament games are NOT
# separately excluded, even though they also carry stake_amount == 0 in
# this codebase (see create_tournament_game). A tournament game is
# eligible for takeback/extra-time exactly when any other game is -
# stake_amount == 0.
EXTRA_TIME_SECONDS = 60
CUSTOM_CLOCK_PRESET_FREE_LIMIT = 3


def _require_casual_untracked_game(game: dict) -> None:
    """Shared guard for takeback_token and extra_time - raises 400 unless
    the game is unstaked (stake_amount == 0), matching the spec's literal
    "casual games only" decision. Tournament games are not separately
    excluded - see the Phase 4e scope note above."""
    if game.get("stake_amount", 0) > 0:
        raise HTTPException(status_code=400, detail="This action is only available in casual (non-staked) games")


@api_router.post("/games/{game_id}/takeback")
async def request_takeback(game_id: str, request: Request):
    """Phase 4e: spend a 'takeback token' to instantly undo your own last
    move. Casual (unstaked) games only (see _require_casual_untracked_game).

    Scope: this undoes exactly one ply - your own last move - and only
    while it's still your opponent's turn to reply (i.e. before they've
    moved again). It cannot be used to undo an opponent's move, and it
    cannot reach further back than the single most recent move. This
    keeps the semantics simple (no risk of un-defining what "current
    state" even means several moves deep) and matches the everyday sense
    of "let me take that back" - catching your own blunder immediately,
    not rewriting history after the game has moved on.
    """
    user = await get_current_user(request)
    game = await db.games.find_one({"game_id": game_id}, {"_id": 0})
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    if game.get("status") != "active":
        raise HTTPException(status_code=400, detail="Game is not active")
    _require_casual_untracked_game(game)

    white = game.get("white_player") or {}
    black = game.get("black_player") or {}
    if user["user_id"] == white.get("user_id"):
        my_color = "white"
    elif user["user_id"] == black.get("user_id"):
        my_color = "black"
    else:
        raise HTTPException(status_code=403, detail="Not a player in this game")

    moves = game.get("moves", [])
    if not moves:
        raise HTTPException(status_code=400, detail="No moves to take back")

    # current_turn is whoever moves NEXT, i.e. the opponent of whoever
    # just moved - so the last mover is the other color.
    expected_current_turn = game["current_turn"]
    last_mover = "black" if expected_current_turn == "white" else "white"
    if last_mover != my_color:
        raise HTTPException(status_code=403, detail="You can only take back your own last move, before your opponent replies")

    fen_history = game.get("fen_history") or []
    clock_history = game.get("clock_history") or []
    if not fen_history:
        # Game predates this feature's history-tracking (see
        # create_tournament_game/create_game comments), or something else
        # left the arrays out of sync with `moves` - either way there's
        # nothing safe to restore to.
        raise HTTPException(status_code=400, detail="Takeback isn't available for this move")

    spend_result = await spend_credits(user["user_id"], "takeback_token", reference_id=game_id)

    restored_fen = fen_history[-1]
    restored_clock = clock_history[-1] if clock_history else {}
    time_updates = {}
    if restored_clock.get("white_time") is not None:
        time_updates["white_time"] = restored_clock["white_time"]
    if restored_clock.get("black_time") is not None:
        time_updates["black_time"] = restored_clock["black_time"]

    # Atomic conditional update: only apply if the game is still exactly
    # where we read it (active, same current_turn) - guards against the
    # opponent sneaking in a reply in the race window between our read
    # and this write. If we lose that race, refund the token rather than
    # leave the user charged for a takeback that never happened.
    updated_game = await db.games.find_one_and_update(
        {"game_id": game_id, "status": "active", "current_turn": expected_current_turn},
        {
            "$pop": {"moves": 1, "move_times": 1, "fen_history": 1, "clock_history": 1},
            "$set": {
                "fen": restored_fen,
                "current_turn": last_mover,
                **time_updates,
            },
        },
        return_document=ReturnDocument.AFTER,
        projection={"_id": 0},
    )
    if updated_game is None:
        await grant_credits(
            user["user_id"], spend_result["cost"], "refund",
            reference_id=spend_result.get("tx_id"),
            metadata={"reason": "takeback_race_lost", "game_id": game_id},
        )
        raise HTTPException(status_code=409, detail="Game state changed - please try again")

    room_name = str(game_id)
    payload = {
        "game_id": game_id,
        "fen": restored_fen,
        "current_turn": last_mover,
        "moves": updated_game.get("moves", []),
        "white_time": updated_game.get("white_time"),
        "black_time": updated_game.get("black_time"),
        "by": user["user_id"],
    }
    await sio.emit('takeback_applied', payload, room=room_name)

    return {
        "success": True,
        "game": GameResponse(**updated_game),
        "credits_charged": spend_result["cost"],
        "credits_balance": spend_result["credits_balance"],
    }


@api_router.post("/games/{game_id}/add-time")
async def add_time_to_clock(game_id: str, request: Request):
    """Phase 4e: spend credits to add EXTRA_TIME_SECONDS to your OWN
    clock in a live casual, non-tournament game. Cannot add time to the
    opponent's clock - this is a personal convenience purchase, not a way
    to hobble the other player."""
    user = await get_current_user(request)
    game = await db.games.find_one({"game_id": game_id}, {"_id": 0})
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    if game.get("status") != "active":
        raise HTTPException(status_code=400, detail="Game is not active")
    _require_casual_untracked_game(game)

    white = game.get("white_player") or {}
    black = game.get("black_player") or {}
    if user["user_id"] == white.get("user_id"):
        my_color = "white"
    elif user["user_id"] == black.get("user_id"):
        my_color = "black"
    else:
        raise HTTPException(status_code=403, detail="Not a player in this game")

    spend_result = await spend_credits(user["user_id"], "extra_time", reference_id=game_id)

    time_field = f"{my_color}_time"
    updated_game = await db.games.find_one_and_update(
        {"game_id": game_id, "status": "active"},
        {"$inc": {time_field: EXTRA_TIME_SECONDS}},
        return_document=ReturnDocument.AFTER,
        projection={"_id": 0},
    )
    if updated_game is None:
        # Game ended in the race window between charging and applying -
        # refund rather than leave the user charged for nothing.
        await grant_credits(
            user["user_id"], spend_result["cost"], "refund",
            reference_id=spend_result.get("tx_id"),
            metadata={"reason": "add_time_game_ended", "game_id": game_id},
        )
        raise HTTPException(status_code=400, detail="Game is no longer active")

    room_name = str(game_id)
    await sio.emit('clock_time_added', {
        "game_id": game_id,
        "color": my_color,
        "seconds_added": EXTRA_TIME_SECONDS,
        "white_time": updated_game.get("white_time"),
        "black_time": updated_game.get("black_time"),
        "by": user["user_id"],
    }, room=room_name)

    return {
        "success": True,
        "color": my_color,
        "seconds_added": EXTRA_TIME_SECONDS,
        "white_time": updated_game.get("white_time"),
        "black_time": updated_game.get("black_time"),
        "credits_charged": spend_result["cost"],
        "credits_balance": spend_result["credits_balance"],
    }


# ---- Custom Chess Clock presets ----
# The standalone Chess Clock tool (/chess-clock) is entirely client-side
# today - no backend game object, just a set of built-in defaults
# (1+0, 3+0, 5+0, 10+0, 15+10, matching Lobby.jsx's TIME_CONTROLS). This
# adds the ability to save custom named time controls beyond those
# defaults. First CUSTOM_CLOCK_PRESET_FREE_LIMIT saved presets per user
# are free; each one beyond that costs "custom_clock_preset" credits.
# Modeled as a persistent buy-once-keep-forever count (like Phase 4b's
# puzzle_pack), not a daily/monthly budget, since a saved preset doesn't
# expire.
#
# Concurrency note: the free-count check below is read-then-write, not
# claimed atomically like _claim_unlock's keyed unlocks - two truly
# simultaneous "save preset" requests from the same user could in theory
# both see count < free_limit and both save for free. Unlike credits or
# wallet balance, the worst case here is one extra free row in a list the
# user manages themselves, not a monetary loss - not worth the extra
# complexity of a transactional claim for that.

@api_router.get("/clock-presets")
async def list_clock_presets(request: Request):
    user = await get_current_user(request)
    presets = await db.custom_clock_presets.find(
        {"user_id": user["user_id"]}, {"_id": 0}
    ).sort("created_at", 1).to_list(200)
    cost = await get_credit_feature_cost("custom_clock_preset")
    return {
        "presets": presets,
        "free_limit": CUSTOM_CLOCK_PRESET_FREE_LIMIT,
        "used": len(presets),
        "remaining_free": max(0, CUSTOM_CLOCK_PRESET_FREE_LIMIT - len(presets)),
        "extra_preset_cost": cost,
    }


@api_router.post("/clock-presets")
async def create_clock_preset(preset_data: ClockPresetCreate, request: Request):
    user = await get_current_user(request)
    if preset_data.white_minutes <= 0 or preset_data.black_minutes <= 0:
        raise HTTPException(status_code=400, detail="Minutes must be greater than 0")
    if not preset_data.name.strip():
        raise HTTPException(status_code=400, detail="Preset name is required")

    existing_count = await db.custom_clock_presets.count_documents({"user_id": user["user_id"]})
    paid = existing_count >= CUSTOM_CLOCK_PRESET_FREE_LIMIT

    preset_id = f"clockpreset_{uuid.uuid4().hex[:12]}"
    spend_result = None
    if paid:
        spend_result = await spend_credits(user["user_id"], "custom_clock_preset", reference_id=preset_id)

    preset_doc = {
        "preset_id": preset_id,
        "user_id": user["user_id"],
        "name": preset_data.name.strip()[:60],
        "white_minutes": preset_data.white_minutes,
        "black_minutes": preset_data.black_minutes,
        "increment_seconds": max(0, preset_data.increment_seconds),
        "tx_id": spend_result["tx_id"] if spend_result else None,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        await db.custom_clock_presets.insert_one(dict(preset_doc))
    except Exception:
        if spend_result:
            await grant_credits(
                user["user_id"], spend_result["cost"], "refund",
                reference_id=spend_result.get("tx_id"),
                metadata={"reason": "clock_preset_create_failed"},
            )
        raise

    preset_doc.pop("_id", None)
    return {
        "success": True,
        "preset": ClockPresetResponse(**preset_doc),
        "paid": paid,
        "credits_charged": spend_result["cost"] if spend_result else 0,
        "credits_balance": spend_result["credits_balance"] if spend_result else None,
    }


@api_router.delete("/clock-presets/{preset_id}")
async def delete_clock_preset(preset_id: str, request: Request):
    """Deletes a saved preset. Does not refund any credits that were
    spent to save it beyond the free cap - same non-refundable-once-
    granted precedent as every other Phase 4 unlock/spend."""
    user = await get_current_user(request)
    result = await db.custom_clock_presets.delete_one({"preset_id": preset_id, "user_id": user["user_id"]})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Preset not found")
    return {"success": True}


# ============= WITHDRAWAL MANAGEMENT =============

@api_router.get("/admin/withdrawals")
async def admin_get_withdrawals(request: Request, status: Optional[str] = None):
    """Get all withdrawal requests for admin review"""
    await get_admin_user(request)
    
    query = {}
    if status:
        query["status"] = status
    
    withdrawals = await db.withdrawals.find(query, {"_id": 0}).sort("created_at", -1).limit(100).to_list(100)
    return withdrawals

@api_router.get("/admin/withdrawals/pending")
async def admin_get_pending_withdrawals(request: Request):
    """Get pending withdrawal requests"""
    await get_admin_user(request)
    
    withdrawals = await db.withdrawals.find(
        {"status": "pending"}, 
        {"_id": 0}
    ).sort("created_at", -1).to_list(100)
    return withdrawals

@api_router.put("/admin/withdrawals/{withdrawal_id}/confirm")
async def admin_confirm_withdrawal(withdrawal_id: str, request: Request):
    """Admin confirms a withdrawal request"""
    admin = await get_admin_user(request)
    body = await request.json()
    admin_note = body.get("admin_note", "")
    
    # Get the withdrawal
    withdrawal = await db.withdrawals.find_one({"withdrawal_id": withdrawal_id})
    if not withdrawal:
        raise HTTPException(status_code=404, detail="Withdrawal not found")
    
    if withdrawal["status"] != "pending":
        raise HTTPException(status_code=400, detail=f"Withdrawal already {withdrawal['status']}")
    
    # Update withdrawal status
    await db.withdrawals.update_one(
        {"withdrawal_id": withdrawal_id},
        {
            "$set": {
                "status": "confirmed",
                "confirmed_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "confirmed_by": admin["user_id"],
                "admin_note": admin_note
            }
        }
    )
    
    # Update transaction status
    await db.transactions.update_one(
        {"withdrawal_id": withdrawal_id},
        {"$set": {"status": "completed"}}
    )
    
    # Notify user via WebSocket
    await sio.emit('withdrawal_status_update', {
        "withdrawal_id": withdrawal_id,
        "status": "confirmed",
        "message": "Your withdrawal has been confirmed and processed.",
        "admin_note": admin_note
    }, room=f"user_{withdrawal['user_id']}")
    
    logger.info(f"Withdrawal {withdrawal_id} confirmed by admin {admin['user_id']}")
    
    return {"success": True, "message": "Withdrawal confirmed"}

@api_router.put("/admin/withdrawals/{withdrawal_id}/reject")
async def admin_reject_withdrawal(withdrawal_id: str, request: Request):
    """Admin rejects a withdrawal request and refunds the balance"""
    admin = await get_admin_user(request)
    body = await request.json()
    admin_note = body.get("admin_note", "Withdrawal rejected by admin")
    
    # Get the withdrawal
    withdrawal = await db.withdrawals.find_one({"withdrawal_id": withdrawal_id})
    if not withdrawal:
        raise HTTPException(status_code=404, detail="Withdrawal not found")
    
    if withdrawal["status"] != "pending":
        raise HTTPException(status_code=400, detail=f"Withdrawal already {withdrawal['status']}")
    
    # Refund the balance to user
    await db.users.update_one(
        {"user_id": withdrawal["user_id"]},
        {"$inc": {f"wallet_balance.{withdrawal['currency']}": withdrawal["amount"]}}
    )
    
    # Update withdrawal status
    await db.withdrawals.update_one(
        {"withdrawal_id": withdrawal_id},
        {
            "$set": {
                "status": "rejected",
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "rejected_by": admin["user_id"],
                "admin_note": admin_note
            }
        }
    )
    
    # Update transaction status
    await db.transactions.update_one(
        {"withdrawal_id": withdrawal_id},
        {"$set": {"status": "rejected"}}
    )
    
    # Create refund transaction
    await db.transactions.insert_one({
        "tx_id": f"tx_{uuid.uuid4().hex[:12]}",
        "user_id": withdrawal["user_id"],
        "tx_type": "refund",
        "amount": withdrawal["amount"],
        "currency": withdrawal["currency"],
        "status": "completed",
        "related_withdrawal_id": withdrawal_id,
        "created_at": datetime.now(timezone.utc).isoformat()
    })
    
    # Notify user via WebSocket
    await sio.emit('withdrawal_status_update', {
        "withdrawal_id": withdrawal_id,
        "status": "rejected",
        "message": "Your withdrawal was rejected. Balance has been refunded.",
        "admin_note": admin_note
    }, room=f"user_{withdrawal['user_id']}")
    
    logger.info(f"Withdrawal {withdrawal_id} rejected by admin {admin['user_id']}, balance refunded")
    
    return {"success": True, "message": "Withdrawal rejected and balance refunded"}

@api_router.get("/wallet/withdrawals")
async def get_user_withdrawals(request: Request):
    """Get current user's withdrawal history"""
    user = await get_current_user(request)
    
    withdrawals = await db.withdrawals.find(
        {"user_id": user["user_id"]},
        {"_id": 0}
    ).sort("created_at", -1).limit(50).to_list(50)
    
    return withdrawals

# ============= SOCKET.IO EVENTS =============

# Track active connections per game for debugging
game_connections = {}
# Map socket id to user_id and games
sid_to_user = {}
sid_to_games = {}
# Map game_id -> user_id -> set(sids)
game_user_sids = {}
# Disconnect timers: (game_id, user_id) -> asyncio.Task
disconnect_tasks = {}

@sio.event
async def connect(sid, environ, auth):
    logger.info(f"Client connected: {sid} auth={auth}")

@sio.event
async def disconnect(sid):
    logger.info(f"Client disconnected: {sid}")
    # Clean up game connections
    user_id = sid_to_user.get(sid)
    games = sid_to_games.get(sid, set())
    for game_id in list(games):
        # remove sid from generic connection tracking
        if sid in game_connections.get(game_id, set()):
            game_connections[game_id].discard(sid)

        # remove sid from per-game user mapping
        if game_id in game_user_sids and user_id:
            user_sids = game_user_sids[game_id].get(user_id, set())
            user_sids.discard(sid)
            if not user_sids:
                # schedule disconnect timeout for this user in this game
                task_key = (game_id, user_id)
                if task_key in disconnect_tasks:
                    # already scheduled
                    continue
                disconnect_tasks[task_key] = asyncio.create_task(start_disconnect_timer(game_id, user_id))
                try:
                    await db.games.update_one(
                        {"game_id": game_id},
                        {
                            "$set": {
                                "reconnect_deadline": (datetime.now(timezone.utc) + timedelta(seconds=40)).isoformat()
                            }
                        }
                    )
                except Exception as e:
                    logger.error(f"Failed to set reconnect deadline for {game_id}: {e}")

    # cleanup sid maps
    sid_to_user.pop(sid, None)
    sid_to_games.pop(sid, None)


async def start_disconnect_timer(game_id: str, user_id: str, timeout: int = 40):
    """Wait `timeout` seconds; if user has not reconnected to the game, declare opponent winner."""
    try:
        await asyncio.sleep(timeout)
        # If user rejoined, cancel
        sids = game_user_sids.get(game_id, {}).get(user_id, set())
        if sids:
            return

        # Fetch game state
        game = await db.games.find_one({"game_id": game_id}, {"_id": 0})
        if not game or game.get("status") != "active":
            return

        # Determine opponent
        white = game.get("white_player")
        black = game.get("black_player")
        if not white or not black:
            return

        if white.get("user_id") == user_id:
            winner = black
            loser = white
            winner_color = "black"
        else:
            winner = white
            loser = black
            winner_color = "white"

        # Mark game completed due to disconnect timeout. `result` must be
        # the winning color ("white"/"black"), matching every other game-end
        # path - update_tournament_leaderboard_for_game below only knows how
        # to score "white"/"black"/"draw", so storing anything else (e.g.
        # the old "resignation" reason string) silently skips the tournament
        # entirely: the two players never get freed from "in_match" and
        # arena pairing quietly runs out of eligible players over time.
        await db.games.update_one(
            {"game_id": game_id},
            {"$set": {
                "status": "completed",
                "result": winner_color,
                "winner_id": winner["user_id"],
                "end_reason": "disconnect_timeout",
                "ended_at": datetime.now(timezone.utc).isoformat()
            }}
        )

        # Update player stats
        await db.users.update_one({"user_id": winner["user_id"]}, {"$inc": {"wins": 1, "games_played": 1}})
        await db.users.update_one({"user_id": loser["user_id"]}, {"$inc": {"losses": 1, "games_played": 1}})

        # Transfer stakes if any (winner gets pot minus arbiter fee)
        stake = game.get("stake_amount", 0)
        if stake and stake > 0:
            pot = stake * 2
            fee = pot * game.get("arbiter_fee", 0.02)
            payout = pot - fee
            await db.users.update_one({"user_id": winner["user_id"]}, {"$inc": {f"wallet_balance.{game.get('stake_currency')}": payout}})

        # Emit game_ended event to room
        await sio.emit('game_ended', {
            "game_id": game_id,
            "result": winner["user_id"],
            "reason": "disconnect_timeout",
            "tournament_id": game.get("tournament_id")
        }, room=game_id)

        # Free up the two tournament players (in_match -> False) and
        # immediately trigger the next round of arena pairing, same as every
        # other way a tournament game can end. Without this, a disconnect
        # timeout leaves both players permanently stuck "in a match" and the
        # tournament silently stops pairing once enough of these pile up.
        game["result"] = winner_color
        await update_tournament_leaderboard_for_game(game)

        # cleanup any tracking
        disconnect_tasks.pop((game_id, user_id), None)
        if game_id in game_user_sids and user_id in game_user_sids[game_id]:
            game_user_sids[game_id].pop(user_id, None)

        # remove generic room connections entry
        game_connections.pop(game_id, None)

        logger.info(f"Game {game_id} ended due to disconnect timeout: winner={winner['user_id']}")

    except asyncio.CancelledError:
        # Timer was cancelled because user reconnected
        logger.info(f"Disconnect timer cancelled for game {game_id}, user {user_id}")
        return
    except Exception as e:
        logger.error(f"Error in disconnect timer for {game_id}/{user_id}: {e}")

@sio.event
async def join_admin_room(sid, data):
    """Admin joins the admin notification room"""
    logger.info(f"Attempting to enter room: admin_room (sid={sid}, room_repr={repr('admin_room')}, room_type={type('admin_room')})")
    print(f"[PRINT] Attempting to enter room: admin_room (sid={sid}, room_repr={repr('admin_room')}, room_type={type('admin_room')})")
    try:
        await sio.enter_room(sid, "admin_room")
    except KeyError:
        logger.warning(f"Unable to enter admin_room for disconnected sid {sid}")
        return
    logger.info(f"Admin client {sid} joined admin_room")
    print(f"[PRINT] Admin client {sid} joined admin_room")
    await sio.emit('joined_admin_room', {"success": True}, room=sid)

@sio.event
async def join_user_room(sid, data):
    """User joins their personal notification room"""
    user_id = data.get("user_id")
    if user_id:
        room_name = f"user_{user_id}"
        logger.info(f"Attempting to enter room: {room_name} (sid={sid}, room_repr={repr(room_name)}, room_type={type(room_name)})")
        print(f"[PRINT] Attempting to enter room: {room_name} (sid={sid}, room_repr={repr(room_name)}, room_type={type(room_name)})")
        try:
            await sio.enter_room(sid, room_name)
        except KeyError:
            logger.warning(f"Unable to enter user room {room_name} for disconnected sid {sid}")
            return
        # Map sid to user for reconnect/disconnect handling
        sid_to_user[sid] = user_id
        sid_to_games.setdefault(sid, set())

        logger.info(f"User {user_id} joined their notification room: {room_name}")
        print(f"[PRINT] User {user_id} joined their notification room: {room_name}")
        await sio.emit('joined_user_room', {"success": True, "user_id": user_id}, room=sid)

@sio.event
async def join_game(sid, data):
    game_id = data.get("game_id")
    user_id = data.get("user_id")
    if game_id:
        room_name = str(game_id)
        logger.info(f"Attempting to enter room: {room_name} (sid={sid}, room_repr={repr(room_name)}, room_type={type(room_name)})")
        print(f"[PRINT] Attempting to enter room: {room_name} (sid={sid}, room_repr={repr(room_name)}, room_type={type(room_name)})")
        await sio.enter_room(sid, room_name)

        # Track generic connection
        if room_name not in game_connections:
            game_connections[room_name] = set()
        game_connections[room_name].add(sid)

        # Track sid->user and sid->games
        if user_id:
            sid_to_user[sid] = user_id
            sid_to_games.setdefault(sid, set()).add(game_id)

            # Track per-game user sids
            game_user_sids.setdefault(room_name, {}).setdefault(user_id, set()).add(sid)

            # Cancel existing disconnect timer if user rejoined
            task_key = (game_id, user_id)
            task = disconnect_tasks.pop(task_key, None)
            if task and not task.done():
                task.cancel()
                try:
                    await db.games.update_one(
                        {"game_id": game_id},
                        {"$unset": {"reconnect_deadline": ""}}
                    )
                except Exception as e:
                    logger.error(f"Failed to unset reconnect deadline for {game_id} on reconnect: {e}")

        logger.info(f"Client {sid} joined game room '{room_name}', total in room: {len(game_connections[room_name])}")
        print(f"[PRINT] Client {sid} joined game room '{room_name}', total in room: {len(game_connections[room_name])}")

        # Send current game state to newly connected client
        game = await db.games.find_one({"game_id": game_id}, {"_id": 0})
        if game:
            await sio.emit('game_sync', {
                "game_id": game_id,
                "fen": game.get("fen", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"),
                "current_turn": game.get("current_turn", "white"),
                "status": game.get("status"),
                "moves": game.get("moves", [])
            }, room=sid)

        try:
            messages = await db.chat_messages.find({"game_id": game_id}, {"_id": 0}).sort("timestamp", 1).to_list(100)
        except Exception as e:
            logger.error(f"Failed to load chat history for {game_id}: {e}")
            messages = []

        await sio.emit('chat_history', {
            "game_id": game_id,
            "messages": messages
        }, room=sid)

        await sio.emit('joined_game', {"game_id": game_id}, room=sid)

@sio.event
async def leave_game(sid, data):
    game_id = data.get("game_id")
    if game_id:
        room_name = str(game_id)
        logger.info(f"Leaving room: {room_name} (sid={sid})")
        print(f"[PRINT] Leaving room: {room_name} (sid={sid})")
        await sio.leave_room(sid, room_name)
        if room_name in game_connections:
            game_connections[room_name].discard(sid)
        logger.info(f"Client {sid} left game room '{room_name}'")
        print(f"[PRINT] Client {sid} left game room '{room_name}'")

@sio.event
async def game_move(sid, data):
    """Handle real-time move broadcast from client"""
    game_id = data.get("game_id")
    move = data.get("move")
    fen = data.get("fen")
    current_turn = data.get("current_turn")
    
    if game_id and move and fen:
        room_name = str(game_id)
        room_clients = game_connections.get(room_name, set())
        logger.info(f"🎮 game_move received: sid={sid}, game_id={game_id}, room_name={room_name}, move={move}, clients_in_room={len(room_clients)}")
        print(f"[PRINT] 🎮 game_move received: sid={sid}, game_id={game_id}, room_name={room_name}, move={move}, clients_in_room={len(room_clients)}")
        # Broadcast to all OTHER clients in the game room
        await sio.emit('move_made', {
            "game_id": game_id,
            "move": move,
            "fen": fen,
            "current_turn": current_turn
        }, room=room_name, skip_sid=sid)
        logger.info(f"✅ Broadcast move_made to room {room_name} (except sender {sid})")
        print(f"[PRINT] ✅ Broadcast move_made to room {room_name} (except sender {sid})")

@sio.event
async def chat_message(sid, data):
    game_id = data.get("game_id")
    message = data.get("message")
    username = data.get("username")
    user_id = sid_to_user.get(sid)

    if not game_id or not message:
        return

    game = await db.games.find_one({"game_id": game_id}, {"_id": 0, "white_player": 1, "black_player": 1})
    if not game:
        return

    # Spectators may only chat if both players allow spectator chat
    const_player_ids = {game.get("white_player", {}).get("user_id"), game.get("black_player", {}).get("user_id")}
    is_participant = user_id in const_player_ids
    allow_spectator_chat = (
        game.get("white_player", {}).get("allow_chat_broadcast", True) is not False and
        game.get("black_player", {}).get("allow_chat_broadcast", True) is not False
    )
    if not is_participant and not allow_spectator_chat:
        return

    # Attach sender metadata so clients can display avatars in chat.
    chat_doc = {
        "game_id": game_id,
        "user_id": user_id,
        "username": username,
        "message": message,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }

    if user_id:
        try:
            user_record = await db.users.find_one({"user_id": user_id}, {"_id": 0, "picture": 1})
            if user_record and user_record.get("picture"):
                chat_doc["picture"] = user_record["picture"]
        except Exception as e:
            logger.error(f"Failed to load user picture for chat message: {e}")

    try:
        await db.chat_messages.insert_one(chat_doc)
    except Exception as e:
        logger.error(f"Failed to persist chat message: {e}")

    emit_doc = {k: v for k, v in chat_doc.items() if k != '_id'}
    await sio.emit('chat_message', emit_doc, room=game_id)


@sio.event
async def time_update(sid, data):
    game_id = data.get("game_id")
    white_time = data.get("white_time")
    black_time = data.get("black_time")
    
    if game_id:
        # Broadcast to other clients
        await sio.emit('time_sync', {
            "white_time": white_time,
            "black_time": black_time
        }, room=game_id, skip_sid=sid)

        # Persist times to DB so new joiners and REST fetches see accurate timers
        try:
            await db.games.update_one(
                {"game_id": game_id},
                {"$set": {"white_time": white_time, "black_time": black_time}}
            )
        except Exception as e:
            logger.error(f"Failed to persist time_update for {game_id}: {e}")

@sio.event
async def threefold_repetition(sid, data):
    """Handle threefold repetition draw claim"""
    game_id = data.get("game_id")
    fen = data.get("fen")

    if game_id:
        logger.info(f"Threefold repetition claimed in game {game_id}")

        # Update game in database
        await db.games.update_one(
            {"game_id": game_id},
            {
                "$set": {
                    "status": "completed",
                    "result": "draw",
                    "end_reason": "threefold_repetition",
                    "ended_at": datetime.now(timezone.utc).isoformat()
                }
            }
        )
        
        # Update player stats
        game = await db.games.find_one({"game_id": game_id}, {"_id": 0})
        if game:
            for player in [game.get("white_player"), game.get("black_player")]:
                if player:
                    await db.users.update_one(
                        {"user_id": player["user_id"]},
                        {"$inc": {"games_played": 1, "draws": 1}}
                    )
            
            # Refund stakes if any
            if game.get("stake_amount", 0) > 0:
                for player in [game.get("white_player"), game.get("black_player")]:
                    if player:
                        await db.users.update_one(
                            {"user_id": player["user_id"]},
                            {"$inc": {f"wallet_balance.{game['stake_currency']}": game["stake_amount"]}}
                        )

            # Free up tournament players and trigger the next round of arena pairing
            game["result"] = "draw"
            await update_tournament_leaderboard_for_game(game)

        # Broadcast draw to both players
        await sio.emit('draw_declared', {
            "game_id": game_id,
            "reason": "threefold_repetition"
        }, room=game_id)

# ============= ROOT ROUTE =============

@api_router.get("/")
async def root():
    return {"message": "StakeChess API", "version": "2.0.0"}


# Temporary debug route to inspect active socket rooms and members
@api_router.get("/debug/rooms")
async def debug_rooms():
    # Convert sets to lists for JSON serialization
    return {room: list(sids) for room, sids in game_connections.items()}


@api_router.get("/debug/cors")
async def debug_cors():
    # Return the effective CORS configuration for debugging
    return {
        "cors_origins_list": cors_origins_list,
        "allow_origin_regex": allow_origin_regex,
    }

@api_router.options("/auth/login")
async def auth_login_options(request: Request):
    origin = request.headers.get("origin")
    response = JSONResponse({"detail": "CORS preflight"})
    if origin in cors_origins_list:
        response.headers["Access-Control-Allow-Origin"] = origin
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    response.headers["Access-Control-Allow-Credentials"] = "true"
    return response

# Include the router in the main app
app.include_router(api_router)

# Define FastAPI lifecycle events BEFORE wrapping with Socket.IO
@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()

@app.on_event("startup")
async def startup_tasks():
    # Credits system (Phase 1) indexes
    await db.credit_transactions.create_index("tx_id", unique=True)
    await db.credit_transactions.create_index([("user_id", 1), ("created_at", -1)])
    await db.credit_feature_costs.create_index("feature_key", unique=True)

    # Phase 4a: per-user unlock/cache collections. Each unique index is
    # what _claim_unlock() relies on to make the "claim before charge"
    # pattern race-safe - a duplicate insert means a concurrent request
    # already won the claim.
    await db.game_review_unlocks.create_index([("user_id", 1), ("game_id", 1)], unique=True)
    await db.pgn_analysis_cache.create_index([("user_id", 1), ("pgn_hash", 1)], unique=True)

    # Board Editor analysis (and any other future lifetime-free-then-paid
    # feature with no natural per-document dedup key) tracks its usage
    # counters here - see _consume_lifetime_budget's docstring.
    await db.feature_usage_counters.create_index("user_id", unique=True)
    await db.migrations.create_index("migration_id", unique=True)

    # Board Editor analysis jobs: looked up by job_id on every poll, and
    # scanned by status at startup to find jobs orphaned by a crash (see
    # _resume_orphaned_board_analysis_jobs).
    await db.board_analysis_jobs.create_index("job_id", unique=True)
    await db.board_analysis_jobs.create_index("status")

    # Game Review jobs: keyed uniquely on game_id (one shared Stockfish
    # run per game, no matter how many users are reviewing it - see
    # get_game_analysis), and scanned by status at startup for the same
    # crash-resume reason as board_analysis_jobs above.
    await db.game_review_jobs.create_index("game_id", unique=True)
    await db.game_review_jobs.create_index("status")

    # Phase 4b: puzzle pack unlocks (persistent, like the unlocks above -
    # you buy a difficulty tier once and keep it). Daily retry/skip
    # budgets live on puzzle_progress instead, no separate index needed.
    await db.puzzle_pack_unlocks.create_index([("user_id", 1), ("difficulty", 1)], unique=True)

    # Phase 4c: daily budget tracker for extra challenge invites (shares
    # the generalized _consume_daily_budget/_record_daily_usage helpers
    # with Phase 4b's puzzle_progress-backed budgets, via a separate
    # collection so the two budgets never collide).
    await db.social_daily_usage.create_index("user_id", unique=True)

    # Phase 4d: monthly usage tracker for PGN imports (same
    # _consume_monthly_budget/_record_monthly_usage shape as the daily
    # budgets above, just month-grained and in its own collection so it
    # never collides with the puzzle/social daily budgets).
    await db.pgn_import_usage.create_index("user_id", unique=True)

    # Phase 4e: custom clock presets (persistent, like puzzle_pack_unlocks -
    # not unique on user_id since a user can own many presets).
    await db.custom_clock_presets.create_index("user_id")
    await db.custom_clock_presets.create_index("preset_id", unique=True)

    # Phase 3: seed a dummy feature cost so spend_credits() / POST
    # /credits/spend can be exercised end-to-end before Phase 4 gates any
    # real feature. Safe to delete once real features are priced.
    await db.credit_feature_costs.update_one(
        {"feature_key": "test_dummy_feature"},
        {
            "$setOnInsert": {
                "feature_key": "test_dummy_feature",
                "cost": 10,
                "category": "test",
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        },
        upsert=True,
    )

    # Phase 4a: initial prices for game review/PGN deep analysis/opening
    # explorer depth. Same $setOnInsert + upsert pattern as 4b/4c/4d/4e -
    # without this, spend_credits() 500s on these feature keys (no
    # configured cost) and Phase 4a is dead on arrival. Never overwrites a
    # price an admin has since changed via
    # PUT /admin/credit-feature-costs/{feature_key}.
    phase_4a_costs = {
        "board_analysis": 30,
        "pgn_deep_analysis": 30,
        "opening_explorer_deep": 5,
    }
    for feature_key, cost in phase_4a_costs.items():
        await db.credit_feature_costs.update_one(
            {"feature_key": feature_key},
            {
                "$setOnInsert": {
                    "feature_key": feature_key,
                    "cost": cost,
                    "category": "analysis",
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            },
            upsert=True,
        )

    # Game Review pricing model migration: it used to be a flat 20-credit
    # per-game unlock (feature_key "game_review") alongside a separate,
    # extra-cost "deep_analysis" upgrade. Both are now merged: game_review
    # is a single 5-free-then-30-credit allowance running at deep depth.
    # This is a genuine one-time pricing/behavior change, not just a
    # first-time default, so it's force-set the FIRST time the server
    # boots with this code - guarded by a migrations flag so it doesn't
    # clobber an admin's price change on every subsequent restart the way
    # a plain $set on every boot would.
    migration_key = "game_review_deep_merge_v1"
    already_migrated = await db.migrations.find_one({"migration_id": migration_key}, {"_id": 0})
    if not already_migrated:
        await db.credit_feature_costs.update_one(
            {"feature_key": "game_review"},
            {
                "$set": {
                    "feature_key": "game_review",
                    "cost": 30,
                    "category": "analysis",
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            },
            upsert=True,
        )
        await db.credit_feature_costs.delete_one({"feature_key": "deep_analysis"})
        await db.migrations.insert_one({
            "migration_id": migration_key,
            "applied_at": datetime.now(timezone.utc).isoformat(),
        })

    # Phase 4b: initial prices for puzzle retries/skips/packs. $setOnInsert
    # + upsert so this only sets a price the first time a feature_key is
    # seen - it will never overwrite a price an admin has since changed via
    # PUT /admin/credit-feature-costs/{feature_key}.
    phase_4b_costs = {
        "puzzle_retry": 5,
        "puzzle_skip": 5,
        "puzzle_pack": 50,
    }
    for feature_key, cost in phase_4b_costs.items():
        await db.credit_feature_costs.update_one(
            {"feature_key": feature_key},
            {
                "$setOnInsert": {
                    "feature_key": feature_key,
                    "cost": cost,
                    "category": "puzzles",
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            },
            upsert=True,
        )

    # Phase 4c: initial prices for boost/rematch/challenge-invite/private-
    # tournament. Same $setOnInsert + upsert pattern as Phase 4b - without
    # this, spend_credits() 500s on all four feature keys (no configured
    # cost) and Phase 4c is dead on arrival. Never overwrites a price an
    # admin has since changed via PUT /admin/credit-feature-costs/{feature_key}.
    phase_4c_costs = {
        "featured_game": 25,
        "rematch_token": 10,
        "challenge_invite_extra": 5,
        "private_tournament_create": 100,
    }
    for feature_key, cost in phase_4c_costs.items():
        await db.credit_feature_costs.update_one(
            {"feature_key": feature_key},
            {
                "$setOnInsert": {
                    "feature_key": feature_key,
                    "cost": cost,
                    "category": "social",
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            },
            upsert=True,
        )

    # Phase 4d: initial price for imports beyond the free monthly cap.
    # Same $setOnInsert + upsert pattern as 4b/4c - without this,
    # spend_credits() 500s on pgn_import_extra once PGN_FREE_MONTHLY_IMPORTS
    # is used up, and never overwrites a price an admin has since changed
    # via PUT /admin/credit-feature-costs/{feature_key}.
    await db.credit_feature_costs.update_one(
        {"feature_key": "pgn_import_extra"},
        {
            "$setOnInsert": {
                "feature_key": "pgn_import_extra",
                "cost": 15,
                "category": "study",
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        },
        upsert=True,
    )

    # Phase 4e: initial prices for takeback/extra-time/clock-presets. Same
    # $setOnInsert + upsert pattern as 4b/4c/4d - without this,
    # spend_credits() 500s on all three feature keys, and never overwrites
    # a price an admin has since changed via
    # PUT /admin/credit-feature-costs/{feature_key}.
    phase_4e_costs = {
        "takeback_token": 15,
        "extra_time": 10,
        "custom_clock_preset": 20,
    }
    for feature_key, cost in phase_4e_costs.items():
        await db.credit_feature_costs.update_one(
            {"feature_key": feature_key},
            {
                "$setOnInsert": {
                    "feature_key": feature_key,
                    "cost": cost,
                    "category": "utility",
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            },
            upsert=True,
        )

    # Create admin user
    admin = await db.users.find_one({"email": "admin@stakechess.com"})
    if not admin:
        admin_doc = {
            "user_id": f"user_{uuid.uuid4().hex[:12]}",
            "username": "admin",
            "email": "admin@stakechess.com",
            "password": get_password_hash("admin123"),
            "rating": 1200,
            "games_played": 0,
            "wins": 0,
            "losses": 0,
            "draws": 0,
            "wallet_balance": {"USDT": 10000.0, "BTC": 1.0, "ETH": 10.0},
            "credits_balance": 0,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "is_admin": True,
            "is_flagged": False,
            "is_banned": False
        }
        await db.users.insert_one(admin_doc)
        # Signup bonus: 400 free credits, granted once here at account creation.
        await grant_credits(admin_doc["user_id"], SIGNUP_BONUS_CREDITS, "signup_bonus")
        logger.info("Admin user created: admin@stakechess.com / admin123")
    
    # Create sample tournaments
    existing_tournaments = await db.tournaments.count_documents({})
    if existing_tournaments == 0:
        sample_tournaments = [
            {
                "tournament_id": f"tourney_{uuid.uuid4().hex[:12]}",
                "name": "Blitz Arena",
                "time_control": "3+2",
                "entry_fee": 5.0,
                "entry_currency": "USDT",
                "prize_pool": 0,
                "min_players": 4,
                "max_players": 64,
                "current_players": 0,
                "tournament_type": "arena",
                "status": "upcoming",
                "start_time": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
                "end_time": None,
                "duration_minutes": 60,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "players": [],
                "leaderboard": []
            },
            {
                "tournament_id": f"tourney_{uuid.uuid4().hex[:12]}",
                "name": "Rapid Arena",
                "time_control": "10+5",
                "entry_fee": 10.0,
                "entry_currency": "USDT",
                "prize_pool": 0,
                "min_players": 4,
                "max_players": 32,
                "current_players": 0,
                "tournament_type": "arena",
                "status": "upcoming",
                "start_time": (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat(),
                "end_time": None,
                "duration_minutes": 90,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "players": [],
                "leaderboard": []
            },
            {
                "tournament_id": f"tourney_{uuid.uuid4().hex[:12]}",
                "name": "Bullet Arena",
                "time_control": "1+1",
                "entry_fee": 2.0,
                "entry_currency": "USDT",
                "prize_pool": 0,
                "min_players": 4,
                "max_players": 128,
                "current_players": 0,
                "tournament_type": "arena",
                "status": "upcoming",
                "start_time": (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat(),
                "end_time": None,
                "duration_minutes": 30,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "players": [],
                "leaderboard": []
            },
            {
                "tournament_id": f"tourney_{uuid.uuid4().hex[:12]}",
                "name": "Daily Classic",
                "time_control": "15+10",
                "entry_fee": 15.0,
                "entry_currency": "USDT",
                "prize_pool": 0,
                "min_players": 8,
                "max_players": 16,
                "current_players": 0,
                "tournament_type": "swiss",
                "status": "upcoming",
                "start_time": (datetime.now(timezone.utc) + timedelta(hours=4)).isoformat(),
                "end_time": None,
                "duration_minutes": 120,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "players": [],
                "leaderboard": []
            }
        ]
        
        await db.tournaments.insert_many(sample_tournaments)
        logger.info("Sample tournaments created")
    
    # Start the scheduler for automated tournaments
    await setup_tournament_scheduler()

    # Repair any placeholder/broken puzzle documents left over from an
    # older seeder (plain starting-position FEN, no solution) so the
    # puzzle trainer shows real, solvable tactics from the first request
    # rather than waiting for the first /puzzles/next call to trigger it.
    puzzle_settings = await db.settings.find_one({"type": "platform"}, {"_id": 0}) or {}
    await seed_puzzles_if_needed(puzzle_settings)

    # Crash-resume: re-run any Board Editor analysis jobs that were still
    # in flight (status "pending") when the previous process died, under
    # their original job_id, so the frontend's poll loop never notices
    # the restart. See _resume_orphaned_board_analysis_jobs's docstring.
    await _resume_orphaned_board_analysis_jobs()

    # Same crash-resume, for Game Review jobs.
    await _resume_orphaned_game_review_jobs()

async def create_automated_tournament(tournament_type: str):
    """Create an automated tournament"""
    try:
        tournament_configs = {
            "bullet": {
                "name": f"Bullet Arena #{random.randint(1000, 9999)}",
                "time_control": "1+0",
                "entry_fee": 2.0,
                "duration_minutes": 30,
                "min_players": 4,
                "max_players": 128
            },
            "blitz": {
                "name": f"Blitz Arena #{random.randint(1000, 9999)}",
                "time_control": "3+2",
                "entry_fee": 5.0,
                "duration_minutes": 60,
                "min_players": 4,
                "max_players": 64
            },
            "rapid": {
                "name": f"Rapid Arena #{random.randint(1000, 9999)}",
                "time_control": "10+5",
                "entry_fee": 10.0,
                "duration_minutes": 90,
                "min_players": 4,
                "max_players": 32
            },
            "classical": {
                "name": f"Classical Swiss #{random.randint(1000, 9999)}",
                "time_control": "15+10",
                "entry_fee": 15.0,
                "duration_minutes": 120,
                "min_players": 8,
                "max_players": 16
            }
        }
        
        config = tournament_configs.get(tournament_type, tournament_configs["blitz"])
        
        tournament = {
            "tournament_id": f"auto_tourney_{uuid.uuid4().hex[:12]}",
            "name": config["name"],
            "time_control": config["time_control"],
            "entry_fee": config["entry_fee"],
            "entry_currency": "USDT",
            "prize_pool": 0,
            "min_players": config["min_players"],
            "max_players": config["max_players"],
            "current_players": 0,
            "tournament_type": "arena" if tournament_type != "classical" else "swiss",
            "status": "upcoming",
            "start_time": (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat(),
            "end_time": None,
            "duration_minutes": config["duration_minutes"],
            "created_at": datetime.now(timezone.utc).isoformat(),
            "players": [],
            "leaderboard": [],
            "automated": True
        }
        
        await db.tournaments.insert_one(tournament)
        logger.info(f"Automated tournament created: {tournament['name']}")
        
    except Exception as e:
        logger.error(f"Failed to create automated tournament: {e}")

async def setup_tournament_scheduler():
    """Setup scheduled jobs for automated tournaments"""
    try:
        # Bullet tournament every 30 minutes
        scheduler.add_job(
            create_automated_tournament,
            IntervalTrigger(minutes=30),
            args=["bullet"],
            id="bullet_tournament",
            replace_existing=True
        )
        
        # Blitz tournament every hour
        scheduler.add_job(
            create_automated_tournament,
            IntervalTrigger(hours=1),
            args=["blitz"],
            id="blitz_tournament",
            replace_existing=True
        )
        
        # Rapid tournament every 2 hours
        scheduler.add_job(
            create_automated_tournament,
            IntervalTrigger(hours=2),
            args=["rapid"],
            id="rapid_tournament",
            replace_existing=True
        )
        
        # Classical tournament daily at midnight UTC
        scheduler.add_job(
            create_automated_tournament,
            CronTrigger(hour=0, minute=0),
            args=["classical"],
            id="classical_tournament",
            replace_existing=True
        )

        # Runs every few seconds: auto-starts due tournaments, keeps active
        # arena tournaments continuously paired (catches anything a game-end
        # event might have missed), and auto-ends tournaments whose duration
        # has elapsed. This is the backbone of "no clicking needed" arenas.
        scheduler.add_job(
            tournament_scheduler_tick,
            IntervalTrigger(seconds=5),
            id="tournament_tick",
            replace_existing=True
        )

        scheduler.start()
        logger.info("Tournament scheduler started with automated jobs")
        
    except Exception as e:
        logger.error(f"Failed to setup tournament scheduler: {e}")

# Mount Socket.IO - this wraps the FastAPI app to handle both HTTP and WebSocket
# The variable name 'app' is used so uvicorn can find it as server:app
_fastapi_app = app
app = socketio.ASGIApp(sio, _fastapi_app, socketio_path="socket.io")

# Wrap the top-level ASGI app with CORS middleware so preflight OPTIONS
# requests received by socketio.ASGIApp are handled with proper headers.
app = CORSMiddleware(
    app,
    allow_origins=cors_origins_list,
    allow_origin_regex=allow_origin_regex,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)

# TODO: Add middleware back later
# # Lightweight ASGI middleware to log incoming HTTP requests (method + path)
# class RequestLoggerMiddleware:
#     ...
# 
# # Wrap with request logger so we can see all incoming paths in logs
# app = RequestLoggerMiddleware(app)
# 
# # Normalize socket.io polling path variants so the ASGIApp matches them
# class PathNormalizeMiddleware:
#     ...
# 
# # Apply path normalization before Preflight handling
# app = PathNormalizeMiddleware(app)
# 
# # Wrap the top-level ASGI app so preflight is handled before Socket.IO
# app = PreflightCORSMiddleware(app, cors_origins_list, allow_origin_regex)
