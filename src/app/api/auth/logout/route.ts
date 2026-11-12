import { NextResponse } from "next/server";
import { clearSession, clearSessionCookieHeaders } from "@/lib/auth";

export async function POST() {
  await clearSession();
  const res = NextResponse.json({ ok: true });
  // Clear both the partitioned and the legacy unpartitioned jar entries.
  for (const cookie of clearSessionCookieHeaders()) {
    res.headers.append("set-cookie", cookie);
  }
  return res;
}
