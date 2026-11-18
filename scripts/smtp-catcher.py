#!/usr/bin/env python3
"""M20 §5 — SMTP catcher (aiosmtpd). Records every message to a JSONL file
so tests can assert REAL delivery (recipient, subject, token-bearing link,
single-use body semantics). Not a production component — a verification tool."""
import asyncio, json, sys
from datetime import datetime, timezone
from aiosmtpd.controller import Controller
from aiosmtpd.handlers import Message

OUT = "/tmp/m20-smtp-catcher.jsonl"

class Recorder(Message):
    def handle_message(self, message):
        rec = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "from": str(message.get("From", "")),
            "to": str(message.get("To", "")),
            "subject": str(message.get("Subject", "")),
            "body": message.get_payload() if message.is_multipart() else str(message.get_payload(decode=False)),
        }
        with open(OUT, "a") as f:
            f.write(json.dumps(rec) + "\n")
        print(f"CAUGHT to={rec['to']} subject={rec['subject']}", flush=True)
        return "250 OK"

if __name__ == "__main__":
    open(OUT, "w").close()
    controller = Controller(Recorder(), hostname="127.0.0.1", port=8025)
    controller.start()
    print("CATCHER_READY", flush=True)
    try:
        asyncio.get_event_loop().run_forever()
    except KeyboardInterrupt:
        controller.stop()
