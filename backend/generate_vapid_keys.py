"""Run once:  python generate_vapid_keys.py   -> paste the two values into Render's environment."""
import base64
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization

b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
key = ec.generate_private_key(ec.SECP256R1())
priv = key.private_numbers().private_value.to_bytes(32, "big")
pub = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
print("VAPID_PUBLIC_KEY=" + b64(pub))
print("VAPID_PRIVATE_KEY=" + b64(priv))
print("VAPID_SUBJECT=mailto:support@outpla.com")
