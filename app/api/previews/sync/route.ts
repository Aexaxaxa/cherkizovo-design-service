import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST() {
  return NextResponse.json(
    {
      error: "Previews are managed in B2, sync disabled"
    },
    { status: 410 }
  );
}
