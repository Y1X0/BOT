"""
Quick outbound-UDP check. WebRTC (py-tgcalls/NTgCalls) needs outbound UDP; most
free PaaS block it. Run this on ANY candidate host BEFORE deploying the whole
streamer:

    python udptest.py

Prints "UDP WORKS" and exits 0 if a STUN reply comes back (host is usable), or
"UDP BLOCKED" and exits 1 otherwise (skip that host).
"""
import os
import socket
import sys


def check() -> bool:
    # Minimal STUN binding request to Google's public STUN server.
    req = b"\x00\x01\x00\x00\x21\x12\xa4\x42" + os.urandom(12)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(5)
    try:
        s.sendto(req, ("stun.l.google.com", 19302))
        data, _ = s.recvfrom(2048)
    except Exception as e:  # timeout / network unreachable
        print(f"❌ UDP BLOCKED — outbound UDP does not work here ({e}).")
        return False
    finally:
        s.close()
    if data[:2].hex() == "0101":
        print("✅ UDP WORKS — outbound UDP / WebRTC is open. This host can run the streamer.")
        return True
    print(f"⚠️ Unexpected STUN reply: {data[:2].hex()} — treat as uncertain.")
    return False


if __name__ == "__main__":
    sys.exit(0 if check() else 1)
