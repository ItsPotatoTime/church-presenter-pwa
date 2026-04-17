"""Phase 0 WebSocket echo server.

Run this, then `cloudflared tunnel --url http://localhost:9999` in another
terminal. Paste the trycloudflare.com URL into the PWA's Tunnel URL field,
tap "Test connection". You should see "echo: ping" arrive back.
"""
import asyncio
import sys

try:
    from websockets.asyncio.server import serve
except ImportError:
    print("Missing dependency. Run: pip install websockets", file=sys.stderr)
    sys.exit(1)


async def handler(ws):
    peer = ws.remote_address
    print(f"+ connected from {peer}", flush=True)
    try:
        async for msg in ws:
            print(f"  recv {msg!r}", flush=True)
            await ws.send(f"echo: {msg}")
    except Exception as e:
        print(f"  ! {e}", flush=True)
    finally:
        print(f"- closed {peer}", flush=True)


async def main():
    port = 9999
    async with serve(handler, "0.0.0.0", port):
        print(f"Echo server listening on ws://0.0.0.0:{port}")
        print("Now run in another terminal:")
        print("  ../../vendor/cloudflared.exe tunnel --url http://localhost:9999")
        print()
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
