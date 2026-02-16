import { NextResponse } from "next/server";
import { templatesRegistry } from "@/lib/templates";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(templatesRegistry);
}
