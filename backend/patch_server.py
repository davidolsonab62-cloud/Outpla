"""
Usage (from your backend folder):   python patch_server.py
Adds push-notification hooks to server.py. Safe to re-run (it skips if already patched).
A backup is saved as server.py.bak.
"""
import shutil, sys

PATH = "server.py"
src = open(PATH, encoding="utf-8", newline="").read()
if "push_service" in src:
    print("server.py already patched - nothing to do."); sys.exit(0)
nl = "\r\n" if "\r\n" in src else "\n"
src = src.replace("\r\n", "\n")

def once(anchor, new, after=True):
    global src
    n = src.count(anchor)
    if n != 1:
        sys.exit(f"ABORTED: expected 1 match, found {n} for:\n{anchor[:120]}")
    src = src.replace(anchor, anchor + new if after else new + anchor)

# 1. import
once("from apscheduler.triggers.interval import IntervalTrigger\n",
     "from push_service import init_push, notify_user\n")

# 2. register endpoints BEFORE the router is included
once("# Include the router in the main app\napp.include_router(api_router)",
     "init_push(db, api_router, get_current_user)\n\n", after=False)

# 3. challenge received
once('        logger.exception("Failed to emit challenge_received")\n',
'''
    notify_user(
        target_user_id,
        f"♟ Challenge from {user.get('username') or 'a player'}",
        (message or "wants to play a game with you"),
        url="/challenge-queue", tag=f"challenge-{challenge_id}",
    )
''')

# 4. challenge accepted
once('        logger.exception("Failed to emit challenge_accepted")\n',
'''
    notify_user(
        challenge.get("from_user_id"),
        f"{user.get('username') or 'Your opponent'} accepted your challenge",
        "Your game is ready - tap to play",
        url=f"/game/{challenge.get('game_id')}", tag=f"challenge-{challenge_id}",
    )
''')

# 5. challenge rejected
once('        logger.exception("Failed to emit challenge_rejected")\n',
'''
    notify_user(
        challenge.get("from_user_id"),
        f"{user.get('username') or 'Your opponent'} declined your challenge",
        "Tap to find another opponent",
        url="/lobby", tag=f"challenge-{challenge_id}",
    )
''')

# 6. direct message
once('''        await sio.emit('direct_message', emit_doc, room=f"user_{user['user_id']}")\n''',
'''        notify_user(
            to_user, f"💬 {user.get('username') or 'New message'}", str(message)[:140],
            url="/messages", tag=f"dm-{user['user_id']}",
        )
''')

# 7. tournament match assigned (also covers "tournament started")
once('''    return game_id\n\nasync def update_tournament_leaderboard_for_game''',
'''    for _p, _opp in ((white_player, black_player), (black_player, white_player)):
        if _p and _p.get("user_id"):
            notify_user(
                _p["user_id"], "🏆 Your tournament match is ready",
                f"vs {(_opp or {}).get('username') or 'your opponent'} - tap to play",
                url=f"/game/{game_id}", tag=f"tmatch-{game_id}",
            )

''', after=False)

# 8. opponent's turn
once("    await sio.emit('move_made', payload, room=room_name)\n",
'''
    try:
        _np = game["white_player"] if next_turn == "white" else game["black_player"]
        _uid = (_np or {}).get("user_id")
        if _uid and _uid != user["user_id"] and not str(_uid).lower().startswith(("bot", "computer", "ai_")):
            notify_user(
                _uid, "♟ Your move", f"{user.get('username') or 'Your opponent'} has moved",
                url=f"/game/{game_id}", tag=f"move-{game_id}",
            )
    except Exception:
        logger.exception("push: move notification failed")
''')

# 9. withdrawals
once('''        "message": "Your withdrawal has been confirmed and processed.",
        "admin_note": admin_note
    }, room=f"user_{withdrawal['user_id']}")\n''',
'''    notify_user(withdrawal["user_id"], "✅ Withdrawal confirmed",
                "Your withdrawal has been confirmed and processed.", url="/wallet", tag=f"wd-{withdrawal_id}")
''')
once('''        "message": "Your withdrawal was rejected. Balance has been refunded.",
        "admin_note": admin_note
    }, room=f"user_{withdrawal['user_id']}")\n''',
'''    notify_user(withdrawal["user_id"], "Withdrawal rejected",
                "Your withdrawal was rejected and your balance was refunded.", url="/wallet", tag=f"wd-{withdrawal_id}")
''')

shutil.copy(PATH, PATH + ".bak")
open(PATH, "w", encoding="utf-8", newline="").write(src.replace("\n", nl))
print("Patched server.py (backup: server.py.bak)")
