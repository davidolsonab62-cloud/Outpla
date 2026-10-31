"""
Outpla push notifications.

 * Web / installed PWA  -> Web Push (VAPID) via pywebpush
 * Android (Capacitor)  -> Firebase Cloud Messaging HTTP v1 (no firebase-admin needed)

Environment variables (set these on Render):
    VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT   (web push)
    FCM_SERVICE_ACCOUNT_JSON                             (entire service-account JSON as one string)

Anything left unset simply disables that channel; the rest of the app keeps working.
"""
import os
import json
import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import HTTPException, Request

logger = logging.getLogger("push")

VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY", "").strip()
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "mailto:support@outpla.com").strip()
FCM_SERVICE_ACCOUNT_JSON = os.environ.get("FCM_SERVICE_ACCOUNT_JSON", "").strip()

_db = None
_fcm_info = None
_fcm_creds = None
_vapid = None


def _load_fcm():
    global _fcm_info
    if _fcm_info is None and FCM_SERVICE_ACCOUNT_JSON:
        try:
            _fcm_info = json.loads(FCM_SERVICE_ACCOUNT_JSON)
        except Exception:
            logger.error("FCM_SERVICE_ACCOUNT_JSON is not valid JSON - Android push disabled")
            _fcm_info = {}
    return _fcm_info or None


def _load_vapid():
    global _vapid
    if _vapid is None and VAPID_PRIVATE_KEY:
        try:
            from py_vapid import Vapid
            try:
                _vapid = Vapid.from_raw(VAPID_PRIVATE_KEY.encode())
            except Exception:
                _vapid = Vapid.from_string(VAPID_PRIVATE_KEY)
        except Exception:
            logger.exception("Could not load VAPID private key - web push disabled")
            _vapid = False
    return _vapid or None


def web_enabled() -> bool:
    return bool(VAPID_PUBLIC_KEY and _load_vapid())


def fcm_enabled() -> bool:
    return bool(_load_fcm())


# --------------------------------------------------------------------------
# Sending
# --------------------------------------------------------------------------
def _send_web_blocking(sub: dict, payload: str) -> Optional[int]:
    """Returns the HTTP status on failure, None on success."""
    from pywebpush import webpush, WebPushException
    try:
        webpush(
            subscription_info={"endpoint": sub["endpoint"], "keys": sub["keys"]},
            data=payload,
            vapid_private_key=_load_vapid(),
            vapid_claims={"sub": VAPID_SUBJECT},
            ttl=3600,
        )
        return None
    except WebPushException as e:
        status = getattr(getattr(e, "response", None), "status_code", None)
        logger.warning("web push failed (%s): %s", status, e)
        return status or 0
    except Exception as e:
        logger.warning("web push error: %s", e)
        return 0


def _fcm_access_token_blocking() -> Optional[str]:
    global _fcm_creds
    info = _load_fcm()
    if not info:
        return None
    from google.oauth2 import service_account
    from google.auth.transport.requests import Request as GRequest
    if _fcm_creds is None:
        _fcm_creds = service_account.Credentials.from_service_account_info(
            info, scopes=["https://www.googleapis.com/auth/firebase.messaging"]
        )
    if not _fcm_creds.valid:
        _fcm_creds.refresh(GRequest())
    return _fcm_creds.token


async def _send_fcm(token: str, title: str, body: str, url: str, tag: Optional[str], data: dict) -> Optional[int]:
    info = _load_fcm()
    if not info:
        return None
    access = await asyncio.to_thread(_fcm_access_token_blocking)
    if not access:
        return None
    msg_data = {k: str(v) for k, v in {**(data or {}), "url": url}.items()}
    message = {
        "message": {
            "token": token,
            "notification": {"title": title, "body": body},
            "data": msg_data,
            "android": {
                "priority": "HIGH",
                "notification": {"channel_id": "outpla_default", **({"tag": tag} if tag else {})},
            },
        }
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(
                f"https://fcm.googleapis.com/v1/projects/{info['project_id']}/messages:send",
                headers={"Authorization": f"Bearer {access}"},
                json=message,
            )
        if r.status_code in (200, 201):
            return None
        logger.warning("FCM send failed %s: %s", r.status_code, r.text[:300])
        return r.status_code
    except Exception as e:
        logger.warning("FCM error: %s", e)
        return 0


async def _notify(user_id: str, title: str, body: str, url: str, tag: Optional[str], data: dict):
    if _db is None or not user_id:
        return
    try:
        subs = await _db.push_subscriptions.find({"user_id": user_id}, {"_id": 0}).to_list(20)
    except Exception:
        logger.exception("could not load push subscriptions")
        return
    payload = json.dumps({"title": title, "body": body, "url": url, "tag": tag or "", "data": data or {}})
    for sub in subs:
        try:
            if sub["kind"] == "web" and web_enabled():
                status = await asyncio.to_thread(_send_web_blocking, sub, payload)
                if status in (404, 410):
                    await _db.push_subscriptions.delete_one({"kind": "web", "key": sub["key"]})
            elif sub["kind"] == "fcm" and fcm_enabled():
                status = await _send_fcm(sub["token"], title, body, url, tag, data or {})
                if status in (400, 404):
                    # 404 = UNREGISTERED. 400 can also be a bad token - drop it either way.
                    await _db.push_subscriptions.delete_one({"kind": "fcm", "key": sub["key"]})
        except Exception:
            logger.exception("push delivery error")


def notify_user(user_id, title: str, body: str, url: str = "/lobby", tag: Optional[str] = None, data: Optional[dict] = None):
    """Fire-and-forget. Safe to call from anywhere; never raises."""
    try:
        asyncio.get_running_loop().create_task(_notify(user_id, title, body, url, tag, data or {}))
    except Exception:
        logger.exception("could not schedule push")


# --------------------------------------------------------------------------
# Setup + endpoints
# --------------------------------------------------------------------------
def init_push(db, api_router, get_current_user):
    global _db
    _db = db

    @api_router.get("/push/config")
    async def push_config():
        return {
            "web_enabled": web_enabled(),
            "fcm_enabled": fcm_enabled(),
            "vapid_public_key": VAPID_PUBLIC_KEY if web_enabled() else "",
        }

    @api_router.post("/push/subscribe")
    async def push_subscribe(request: Request):
        user = await get_current_user(request)
        body = await request.json()
        sub = body.get("subscription") or {}
        endpoint = sub.get("endpoint")
        keys = sub.get("keys") or {}
        if not endpoint or not keys.get("p256dh") or not keys.get("auth"):
            raise HTTPException(status_code=400, detail="Invalid subscription")
        await db.push_subscriptions.update_one(
            {"kind": "web", "key": endpoint},
            {"$set": {
                "user_id": user["user_id"], "kind": "web", "key": endpoint,
                "endpoint": endpoint, "keys": {"p256dh": keys["p256dh"], "auth": keys["auth"]},
                "user_agent": request.headers.get("user-agent", "")[:200],
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }},
            upsert=True,
        )
        return {"success": True}

    @api_router.post("/push/register-device")
    async def push_register_device(request: Request):
        user = await get_current_user(request)
        body = await request.json()
        token = body.get("token")
        if not token:
            raise HTTPException(status_code=400, detail="token required")
        await db.push_subscriptions.update_one(
            {"kind": "fcm", "key": token},
            {"$set": {
                "user_id": user["user_id"], "kind": "fcm", "key": token, "token": token,
                "platform": body.get("platform", "android"),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }},
            upsert=True,
        )
        return {"success": True}

    @api_router.post("/push/unsubscribe")
    async def push_unsubscribe(request: Request):
        user = await get_current_user(request)
        body = await request.json()
        key = body.get("endpoint") or body.get("token")
        if key:
            await db.push_subscriptions.delete_one({"key": key, "user_id": user["user_id"]})
        return {"success": True}

    @api_router.post("/push/test")
    async def push_test(request: Request):
        user = await get_current_user(request)
        notify_user(user["user_id"], "Outpla", "Push notifications are working 🎉", "/lobby", tag="test")
        return {"success": True}
