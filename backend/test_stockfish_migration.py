"""
Phase 1 migration test: analyze_game_with_chess_engine vs analyze_game_with_stockfish.

Requires a real Stockfish binary on STOCKFISH_PATH (or discoverable via
resolve_stockfish_path()) - skips otherwise, same convention the rest of
server.py's engine-gated code follows.

server.py reads MONGO_URL / DB_NAME from os.environ at import time. Motor's
client construction is lazy (no connection is actually opened), so it's safe
to point these at dummy values here if the real environment doesn't already
set them - no live Mongo is needed to run this test.
"""
import os

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")

import pytest

from server import (
    analyze_game_with_stockfish,
    analyze_game_with_chess_engine,
    STOCKFISH_AVAILABLE,
)

# Scholar's mate, as UCI moves from the starting position. Short and fixed,
# and 3...Nf6?? is an outright blunder that walks into mate - so besides
# "best"/"book" this also exercises the blunder branch of the categorization
# logic, not just the easy opening moves.
SCHOLARS_MATE_UCI = ["e2e4", "e7e5", "d1h5", "b8c6", "f1c4", "g8f6", "h5f7"]


@pytest.mark.skipif(not STOCKFISH_AVAILABLE, reason="No Stockfish binary available")
@pytest.mark.asyncio
async def test_categories_match_between_sync_and_async_analysis():
    sync_result = analyze_game_with_stockfish(SCHOLARS_MATE_UCI, depth=8)
    async_result = await analyze_game_with_chess_engine(SCHOLARS_MATE_UCI, depth=8)

    assert sync_result["engine_available"] is True
    assert async_result["engine_available"] is True

    sync_categories = [m.get("category") for m in sync_result["moves"]]
    async_categories = [m.get("category") for m in async_result["moves"]]

    # Depth/eval numbers are allowed to differ slightly by engine version -
    # categories should not.
    assert sync_categories == async_categories, (
        f"category mismatch:\nsync:  {sync_categories}\nasync: {async_categories}"
    )

    # Summary counts are just tallies of the same categories, so they should
    # match too as a sanity check on the tallying logic itself.
    assert sync_result["summary"] == async_result["summary"]
